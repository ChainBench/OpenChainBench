/**
 * Aggregate-snapshot broadcaster.
 *
 * After each Tier A sweep the worker calls `publishAggregateBlob` to:
 *   1. Read back every unfiltered bench snapshot it just wrote to Redis.
 *   2. Materialize a lightweight envelope `{ v, builtAt, benches[] }`.
 *   3. `put()` the JSON to a stable public URL on Vercel Blob so the site
 *      can fetch it CDN-cached, no per-bench Redis fan-out at read time.
 *   4. POST the site's revalidate hook so the CDN cache tag purges
 *      immediately — no waiting on the ~60 s Blob overwrite propagation.
 *
 * Fail-soft: any step (blob read miss, network flap, missing token)
 * degrades to a warning log. The worker's happy path is untouched, the
 * site keeps reading via its existing Redis path via SRH. Once this
 * proves stable, the site switches its aggregate reads to the Blob URL.
 */

import { put } from "@vercel/blob";
import type { Benchmark } from "@/types/benchmark";
import type { Spec } from "@/lib/spec-schema";
import { draftPlaceholderForSpec } from "@/lib/materialize/load";
import { readMaterialized } from "@/lib/materialize/store";

export type PublishResult = {
  ok: boolean;
  url?: string;
  bytes?: number;
  total?: number;
  liveCount?: number;
  draftCount?: number;
  revalidated?: boolean;
  error?: string;
};

const BLOB_PATH = "bench-aggregate/latest.json";
const CACHE_MAX_AGE_SEC = 60;

export async function publishAggregateBlob(
  specs: Spec[],
): Promise<PublishResult> {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    return { ok: false, error: "BLOB_READ_WRITE_TOKEN not set" };
  }

  const benches: Benchmark[] = [];
  let liveCount = 0;
  let draftCount = 0;

  // Read back what the tier-A sweep just wrote. Worker reads Redis via
  // its own TCP client (via OCB_REDIS_URL), never SRH — so this is
  // insulated from the SRH stuck-pool pathology that motivates the
  // whole broadcast refactor. Serial read is fine (worker sweep is not
  // latency-sensitive; user reads are what we're protecting).
  for (const spec of specs) {
    let bench: Benchmark | null = null;
    try {
      const snap = await readMaterialized(spec.slug, "");
      bench = snap?.bench ?? null;
    } catch (err) {
      console.warn(
        `[blob-publish] read ${spec.slug} failed: ${err instanceof Error ? err.message : err}`,
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

  let url: string | undefined;
  try {
    const uploaded = await put(BLOB_PATH, body, {
      access: "public",
      contentType: "application/json",
      cacheControlMaxAge: CACHE_MAX_AGE_SEC,
      addRandomSuffix: false,
      allowOverwrite: true,
      token: blobToken,
    });
    url = uploaded.url;
  } catch (err) {
    return {
      ok: false,
      error: `blob put failed: ${err instanceof Error ? err.message : String(err)}`,
      bytes,
      total: benches.length,
      liveCount,
      draftCount,
    };
  }

  // Best-effort site notify. If the site is unreachable or rejects the
  // hook, the Blob has still been overwritten and will propagate through
  // the CDN within ~60 s. The hook only shortens that window.
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
          `[blob-publish] revalidate hook returned ${res.status} ${res.statusText}`,
        );
      }
    } catch (err) {
      console.warn(
        `[blob-publish] revalidate hook failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return {
    ok: true,
    url,
    bytes,
    total: benches.length,
    liveCount,
    draftCount,
    revalidated,
  };
}
