/**
 * Aggregate + per-bench + per-variant snapshot broadcaster (VPS-served).
 *
 * Layout of the files this module writes into `AGGREGATE_OUTPUT_PATH`,
 * which Caddy exposes publicly at `https://kv.openchainbench.com/aggregate/*`:
 *
 *   latest.json                             All 68 unfiltered benches
 *                                           (homepage source of truth,
 *                                           4-5 MB, ~1.5 MB gzipped).
 *   benches/<slug>.json                     One full unfiltered bench
 *                                           (per-bench detail pages,
 *                                           /api/series/<slug>).
 *   variants/<slug>/<sig>.json              One filtered variant
 *                                           (per-chain, per-region,
 *                                           per-kind, per-venue pages).
 *
 * Every write is atomic (`.tmp` → `rename`) so a Caddy `file_server` GET
 * never observes a torn read.
 *
 * Purpose: eliminate the SRH HTTP-to-Redis proxy from the site's read
 * path entirely. The site fetches these files from the CDN edge instead
 * of fanning out Redis GETs through SRH, which was chronically bursting
 * timeouts (~27 auto-heal incidents / 24 h before this shipped).
 *
 * Fail-soft: any single file write failure is warned and swallowed;
 * one bad bench doesn't block the rest of the cycle.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Benchmark } from "@/types/benchmark";
import type { Spec } from "@/lib/spec-schema";
import {
  draftPlaceholderForSpec,
  filterSig,
  type BenchmarkFilters,
} from "@/lib/materialize/load";
import { readMaterialized } from "@/lib/materialize/store";

export type PublishResult = {
  ok: boolean;
  filePath?: string;
  bytes?: number;
  total?: number;
  liveCount?: number;
  draftCount?: number;
  perBenchOk?: number;
  perBenchBytes?: number;
  revalidated?: boolean;
  error?: string;
};

export type VariantsPublishResult = {
  ok: boolean;
  count?: number;
  bytes?: number;
  errors?: number;
  error?: string;
};

const AGGREGATE_FILENAME = "latest.json";
const BENCHES_SUBDIR = "benches";
const VARIANTS_SUBDIR = "variants";

async function atomicWrite(finalPath: string, body: string): Promise<void> {
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, body, "utf-8");
  await rename(tmpPath, finalPath);
}

/**
 * Tier A publish: aggregate blob + per-bench blobs.
 *
 * Reads every unfiltered bench from Redis (worker uses TCP direct via
 * `OCB_REDIS_URL`, never SRH), assembles a slim aggregate envelope, and
 * ALSO writes one file per live bench so the site's detail pages can
 * read straight from the CDN instead of round-tripping SRH.
 */
export async function publishAggregate(specs: Spec[]): Promise<PublishResult> {
  const outputDir = process.env.AGGREGATE_OUTPUT_PATH;
  if (!outputDir) {
    return { ok: false, error: "AGGREGATE_OUTPUT_PATH not set" };
  }

  const benches: Benchmark[] = [];
  let liveCount = 0;
  let draftCount = 0;

  for (const spec of specs) {
    let bench: Benchmark | null = null;
    try {
      const snap = await readMaterialized(spec.slug, "");
      bench = snap?.bench ?? null;
    } catch (err) {
      console.warn(
        `[publish-aggregate] read ${spec.slug} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (bench) {
      benches.push(bench);
      if (bench.status === "live") liveCount += 1;
      else draftCount += 1;
    } else {
      benches.push(draftPlaceholderForSpec(spec));
      draftCount += 1;
    }
  }

  benches.sort((a, b) => (a.number ?? "").localeCompare(b.number ?? ""));

  const builtAt = Date.now();
  const envelope = {
    v: 1,
    builtAt,
    total: benches.length,
    liveCount,
    draftCount,
    benches,
  };
  const body = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(body);

  const aggregatePath = path.join(outputDir, AGGREGATE_FILENAME);
  const benchesDir = path.join(outputDir, BENCHES_SUBDIR);

  try {
    await mkdir(outputDir, { recursive: true });
    await mkdir(benchesDir, { recursive: true });
    await atomicWrite(aggregatePath, body);
  } catch (err) {
    return {
      ok: false,
      error: `aggregate write failed: ${err instanceof Error ? err.message : String(err)}`,
      bytes,
      total: benches.length,
      liveCount,
      draftCount,
    };
  }

  // Per-bench files. Live benches only — draft placeholders would let
  // the site render "Awaiting" on a per-bench page, which is what the
  // draft-placeholder path already does anyway. Skip the write so stale
  // files don't outlive their benches; the reader falls back to the
  // aggregate slice / SRH transparently.
  let perBenchOk = 0;
  let perBenchBytes = 0;
  for (const bench of benches) {
    if (bench.status !== "live") continue;
    const benchPath = path.join(benchesDir, `${bench.slug}.json`);
    const benchBody = JSON.stringify({
      v: 1,
      builtAt,
      slug: bench.slug,
      bench,
    });
    perBenchBytes += Buffer.byteLength(benchBody);
    try {
      await atomicWrite(benchPath, benchBody);
      perBenchOk += 1;
    } catch (err) {
      console.warn(
        `[publish-aggregate] per-bench ${bench.slug} write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  let revalidated = false;
  const siteUrl = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
  const revalidateToken = process.env.REVALIDATE_TOKEN;
  if (siteUrl && revalidateToken) {
    try {
      const res = await fetch(`${siteUrl}/api/internal/revalidate-aggregate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${revalidateToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      revalidated = res.ok;
      if (!res.ok) {
        console.warn(
          `[publish-aggregate] revalidate hook returned ${res.status} ${res.statusText}`,
        );
      }
    } catch (err) {
      console.warn(
        `[publish-aggregate] revalidate hook failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return {
    ok: true,
    filePath: aggregatePath,
    bytes,
    total: benches.length,
    liveCount,
    draftCount,
    perBenchOk,
    perBenchBytes,
    revalidated,
  };
}

/**
 * Tier B publish: per-variant blobs (chain / region / kind / venue combos).
 *
 * Called after the tier B materialize loop finishes writing every
 * variant to Redis. Enumerates the same (spec, filters) space, reads
 * each variant back, and writes one file per (slug, sig).
 */
export async function publishVariants(
  specs: Spec[],
  variantsFor: (spec: Spec) => BenchmarkFilters[],
): Promise<VariantsPublishResult> {
  const outputDir = process.env.AGGREGATE_OUTPUT_PATH;
  if (!outputDir) {
    return { ok: false, error: "AGGREGATE_OUTPUT_PATH not set" };
  }

  const variantsDir = path.join(outputDir, VARIANTS_SUBDIR);
  await mkdir(variantsDir, { recursive: true });

  const builtAt = Date.now();
  let count = 0;
  let bytes = 0;
  let errors = 0;

  for (const spec of specs) {
    let benchDirEnsured = false;
    for (const filters of variantsFor(spec)) {
      const sig = filterSig(filters);
      if (!sig) continue;

      try {
        const snap = await readMaterialized(spec.slug, sig);
        if (!snap?.bench) continue;

        const benchDir = path.join(variantsDir, spec.slug);
        if (!benchDirEnsured) {
          await mkdir(benchDir, { recursive: true });
          benchDirEnsured = true;
        }
        const filePath = path.join(benchDir, `${sig}.json`);
        const body = JSON.stringify({
          v: 1,
          builtAt,
          slug: spec.slug,
          sig,
          bench: snap.bench,
        });
        bytes += Buffer.byteLength(body);
        await atomicWrite(filePath, body);
        count += 1;
      } catch (err) {
        errors += 1;
        console.warn(
          `[publish-variants] ${spec.slug}/${sig}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  return { ok: true, count, bytes, errors };
}
