/**
 * Persistent snapshot layer for benchmark runtime data.
 *
 * Why this exists: the per-bench unstable_cache + throw-to-preserve
 * pattern handles transient Prom failures while a previous cache exists,
 * but on COLD START (new Vercel instance) during a Prom blackout there
 * is no previous cache to preserve. The user sees "AWAITING samples"
 * even though the bench has perfectly good data from 60 s ago.
 *
 * This module saves the runtime-derived parts of each Benchmark to KV
 * after every successful Prom fetch, and offers them back on the failure
 * path. Editorial metadata (title, abstract, faq, etc.) is rebuilt fresh
 * from the spec on every read so a deploy with edited YAML doesn't keep
 * surfacing stale copy.
 *
 * Storage: native fetch against the Upstash REST API. Vercel injects
 * KV_REST_API_URL + KV_REST_API_TOKEN automatically when a Redis store
 * is attached to the project via the marketplace integration. When the
 * env vars are not set (local dev with no KV configured, or production
 * before a KV store is provisioned), every function in here is a
 * silent no-op — the rest of the data layer behaves exactly as it did
 * before this module existed.
 *
 * Safety properties:
 *   - Writes are fire-and-forget; the caller never awaits them.
 *   - Failures are caught and logged at warn level; no caller path can
 *     break because KV is down.
 *   - Reads validate with Zod and discard anything that doesn't match
 *     the schema (defends against shape drift across deploys).
 *   - Snapshots older than MAX_SNAPSHOT_AGE_MS are refused; better to
 *     surface "AWAITING" than to lie about freshness over a long
 *     outage.
 */

import { z } from "zod";
import type { Benchmark, ProviderResult, ResultExtras } from "@/types/benchmark";

/** Refuse snapshots older than this on read. 24 h matches the bench
 *  query window — a value older than that isn't meaningful as the
 *  "current" leaderboard, so a draft placeholder is more honest. */
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

const KEY_PREFIX = "ocb:snap:v1:";

/** Bump when changing the snapshot payload shape so deploys carrying a
 *  new field don't try to deserialize old-shape values. The Zod schema
 *  below would also reject those, but the version prefix lets us
 *  invalidate without writing strict-mode parsers. */
const SCHEMA_VERSION = 2 as const;

// Minimal runtime payload. Editorial metadata isn't snapshotted because
// it lives in YAML and is rebuilt from the spec on every read.
const SnapshotSchema = z.object({
  _v: z.literal(SCHEMA_VERSION),
  savedAt: z.number().int().positive(),
  lastRunAt: z.string(),
  sampleSize: z.number(),
  results: z.array(z.any()),
  extras: z.any(),
  bestPerChain: z.record(z.string(), z.any()).optional(),
  worstPerChain: z.record(z.string(), z.any()).optional(),
});

export type SnapshotPayload = {
  results: ProviderResult[];
  extras: ResultExtras;
  sampleSize: number;
  lastRunAt: string;
  bestPerChain?: Record<string, ProviderResult>;
  worstPerChain?: Record<string, ProviderResult>;
};

function isConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL?.trim() &&
      process.env.KV_REST_API_TOKEN?.trim(),
  );
}

function kvUrl(): string {
  return (process.env.KV_REST_API_URL ?? "").replace(/\/+$/, "");
}

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` };
}

/**
 * Best-effort save. Never throws, never blocks. Call without `await`
 * from inside a successful Prom path:
 *
 *   writeSnapshot(spec.slug, { results, extras, sampleSize, lastRunAt });
 *
 * Returns immediately; the network call resolves in the background.
 */
export function writeSnapshot(slug: string, payload: SnapshotPayload): void {
  if (!isConfigured()) return;
  const body = JSON.stringify({
    _v: SCHEMA_VERSION,
    savedAt: Date.now(),
    ...payload,
  });
  // Upstash REST: POST /set/{key} with raw body = value.
  fetch(`${kvUrl()}/set/${encodeURIComponent(KEY_PREFIX + slug)}`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body,
    // Server-side fetch is fine without keepalive; no browser limits.
    cache: "no-store",
  }).catch((err) => {
    console.warn(
      `snapshot.write failed for ${slug}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

/**
 * Read the last good snapshot for a slug. Returns null when:
 *   - KV is not configured (env vars missing)
 *   - no snapshot exists for the slug
 *   - the snapshot fails Zod validation (shape drift)
 *   - the snapshot is older than MAX_SNAPSHOT_AGE_MS
 *   - the network call fails or times out
 *
 * All errors are swallowed and logged at warn level so the caller can
 * fall through to its own draft/error path without surprises.
 */
export async function readSnapshot(
  slug: string,
): Promise<SnapshotPayload | null> {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(
      `${kvUrl()}/get/${encodeURIComponent(KEY_PREFIX + slug)}`,
      {
        method: "GET",
        headers: authHeader(),
        cache: "no-store",
        // Short timeout so a slow KV doesn't add latency on cold start
        // where every ms counts.
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!res.ok) {
      console.warn(`[DRAFT-TRACE] kv_http slug=${slug} status=${res.status}`);
      return null;
    }
    const env = (await res.json()) as { result?: string | null };
    if (!env.result) {
      console.warn(`[DRAFT-TRACE] kv_empty slug=${slug} (no snapshot ever written)`);
      return null;
    }
    const raw = JSON.parse(env.result);
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `[DRAFT-TRACE] kv_shape slug=${slug} err=${parsed.error.message}`,
      );
      return null;
    }
    const age = Date.now() - parsed.data.savedAt;
    if (age > MAX_SNAPSHOT_AGE_MS) {
      console.warn(
        `[DRAFT-TRACE] kv_stale slug=${slug} age_min=${Math.round(age / 1000 / 60)}`,
      );
      return null;
    }
    return {
      results: parsed.data.results as ProviderResult[],
      extras: parsed.data.extras as ResultExtras,
      sampleSize: parsed.data.sampleSize,
      lastRunAt: parsed.data.lastRunAt,
      bestPerChain: parsed.data.bestPerChain as
        | Record<string, ProviderResult>
        | undefined,
      worstPerChain: parsed.data.worstPerChain as
        | Record<string, ProviderResult>
        | undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish abort/timeout (most common) from other network errors so
    // the post-incident grep can see if it's KV slowness vs KV down.
    const tag = msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout")
      ? "kv_timeout"
      : "kv_neterr";
    console.warn(`[DRAFT-TRACE] ${tag} slug=${slug} err=${msg}`);
    return null;
  }
}

/** Helper for the spec loader: takes whatever we have in memory and
 *  rebuilds the snapshot-shaped subset of a Benchmark. Used so the
 *  caller doesn't have to repeat the field selection. */
export function snapshotFromBenchmark(b: Benchmark): SnapshotPayload {
  return {
    results: b.results,
    extras: b.extras,
    sampleSize: b.sampleSize,
    lastRunAt: b.lastRunAt,
    // Persist per-chain leader stash so the snapshot-recovery path
    // (loadBenchmarkUnfilteredCached's KV fallback in spec.ts) can
    // reconstruct a Benchmark that still resolves the
    // `{{best_name:chain:X}}` / `{{best_p50:chain:X}}` family of
    // placeholders. Without these, a cold-start fetched from the
    // snapshot serves the raw placeholder string to the page.
    bestPerChain: b.bestPerChain,
    worstPerChain: b.worstPerChain,
  };
}
