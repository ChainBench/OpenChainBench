/**
 * Aggregate-snapshot broadcaster (self-hosted variant).
 *
 * After each Tier A sweep the worker calls `publishAggregate` to:
 *   1. Read back every unfiltered bench snapshot it just wrote to Redis
 *      (worker uses TCP direct via `OCB_REDIS_URL`, never SRH — so the
 *      broadcast is insulated from the very failure mode this whole
 *      pipeline exists to route around).
 *   2. Assemble a lightweight envelope `{ v, builtAt, benches[] }`.
 *   3. Write the JSON to `${AGGREGATE_OUTPUT_PATH}/latest.json` atomically
 *      (write to `.tmp`, `rename` into place — readers never see a torn
 *      snapshot). Caddy on the same VPS serves that path publicly.
 *   4. Optionally POST the site's revalidate hook so the CDN cache tag
 *      purges immediately, no waiting on the ~60 s revalidate window.
 *
 * Fail-soft: any step (missing config, disk full, network flap) degrades
 * to a warning log. The worker's happy path is untouched, the site keeps
 * reading via its existing Redis path via SRH. Once this proves stable,
 * the site switches its aggregate reads to the public aggregate URL.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Benchmark } from "@/types/benchmark";
import type { Spec } from "@/lib/spec-schema";
import { draftPlaceholderForSpec } from "@/lib/materialize/load";
import { readMaterialized } from "@/lib/materialize/store";

export type PublishResult = {
  ok: boolean;
  filePath?: string;
  bytes?: number;
  total?: number;
  liveCount?: number;
  draftCount?: number;
  revalidated?: boolean;
  error?: string;
};

const AGGREGATE_FILENAME = "latest.json";

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

  const envelope = {
    v: 1,
    builtAt: Date.now(),
    total: benches.length,
    liveCount,
    draftCount,
    benches,
  };
  const body = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(body);

  const finalPath = path.join(outputDir, AGGREGATE_FILENAME);
  const tmpPath = `${finalPath}.tmp`;

  try {
    await mkdir(outputDir, { recursive: true });
    // Atomic write: readers (Caddy `file_server`) only ever open a
    // fully-written file. `rename` on the same filesystem is atomic on
    // POSIX so no torn reads possible.
    await writeFile(tmpPath, body, "utf-8");
    await rename(tmpPath, finalPath);
  } catch (err) {
    return {
      ok: false,
      error: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      bytes,
      total: benches.length,
      liveCount,
      draftCount,
    };
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
    filePath: finalPath,
    bytes,
    total: benches.length,
    liveCount,
    draftCount,
    revalidated,
  };
}
