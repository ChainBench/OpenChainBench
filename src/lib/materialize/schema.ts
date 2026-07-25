/**
 * Versioned contract between the materialization worker (writer) and the
 * site (reader). The worker is the ONLY writer; readers never see a
 * partial snapshot thanks to the publish-then-swap pointer pattern
 * (write `ocb:mat:v1:<slug>:<sig>:<hash>`, then swap `...:current`).
 *
 * The envelope is Zod-validated on read; the embedded Benchmark is
 * trusted (single writer, same repo, schema version gates drift).
 */

import { z } from "zod";
import type { Benchmark } from "@/types/benchmark";

// v2: ProviderResult gained `unresponsive` — cohort providers whose
// latency series went Prom-stale (failed probes record no latency) but
// whose call counters still return samples are published as unranked
// rows instead of being carried forward with dead latency values.
// Bumping republishes every blob under the new shape; deploy the worker
// BEFORE the site so v2 blobs exist when readers start asking for them.
export const MAT_SCHEMA_VERSION = 2;

/** Key layout in the store (Upstash Redis, plain strings only: hash
 *  fields cap at 32KB while strings allow 10MB requests). */
export const matKeys = {
  blob: (slug: string, sig: string, hash: string) =>
    `ocb:mat:v${MAT_SCHEMA_VERSION}:${slug}:${sig || "all"}:${hash}`,
  pointer: (slug: string, sig: string) =>
    `ocb:mat:v${MAT_SCHEMA_VERSION}:${slug}:${sig || "all"}:current`,
  /** Last-known-good snapshot, full JSON, NO TTL. Overwritten on every
   *  successful publish; read as the fallback when the current
   *  pointer/blob path misses (blob expired during a long worker
   *  outage, transient Redis error, DEL race). A bench that has
   *  published once never falls back to the "awaiting" placeholder
   *  again — the page serves the stamped-stale copy and the existing
   *  freshness badge (dataAsOf) discloses the age. */
  lkg: (slug: string, sig: string) =>
    `ocb:mat:v${MAT_SCHEMA_VERSION}:${slug}:${sig || "all"}:lkg`,
  /** Worker heartbeat, epoch seconds. Read by /api/cron/health-check. */
  heartbeat: `ocb:mat:v${MAT_SCHEMA_VERSION}:heartbeat`,
};

/** Per-provider carry-forward bookkeeping. `observedAt` is the last
 *  sweep whose Prom queries succeeded for this provider; `staleSince`
 *  is set on the first failed sweep after it and cleared on recovery. */
export const StalenessMetaSchema = z.object({
  observedAt: z.number(),
  staleSince: z.number().optional(),
});
export type StalenessMeta = z.infer<typeof StalenessMetaSchema>;

/** Freshness derived at RENDER time from StalenessMeta (never stored:
 *  a stored enum ages between renders).
 *  fresh: < 5 min since observedAt — normal render, ranked.
 *  stale: 5 min - 6 h — dimmed row, "as of HH:MM" tooltip, still ranked.
 *  dead:  > 6 h — pinned to bottom, unranked, never deleted. */
export const FRESH_MAX_MS = 5 * 60_000;
export const STALE_MAX_MS = 6 * 3600_000;
export type Freshness = "fresh" | "stale" | "dead";
export function freshnessOf(meta: StalenessMeta | undefined, now = Date.now()): Freshness {
  if (!meta) return "fresh"; // legacy data without meta renders as before
  const age = now - meta.observedAt;
  if (age < FRESH_MAX_MS) return "fresh";
  if (age < STALE_MAX_MS) return "stale";
  return "dead";
}

/** Fixed-cadence append-only series ring. `null` = the provider truly
 *  emitted nothing in that bucket (honest gap, never backfilled); the
 *  display values carry forward separately via StalenessMeta. Cadences
 *  mirror the live loader: 24h = 72 pts @ 20 min, 7d = 84 pts @ 2 h,
 *  30d = 60 pts @ 12 h. */
const SeriesRingSchema = z.object({
  /** Epoch ms of points[0]. */
  startEpoch: z.number(),
  stepSec: z.number(),
  points: z.array(z.number().nullable()),
});
export type SeriesRing = z.infer<typeof SeriesRingSchema>;

export const RING_CADENCE = {
  "24h": { points: 72, stepSec: 1200 },
  "7d": { points: 84, stepSec: 7200 },
  "30d": { points: 60, stepSec: 43200 },
} as const;
export type RingWindow = keyof typeof RING_CADENCE;

/** Worker-private state embedded in the snapshot so a worker restart
 *  resumes carry-forward and ring history without re-seeding from Prom. */
export const WorkerStateSchema = z.object({
  /** provider slug → carry-forward meta */
  providers: z.record(z.string(), StalenessMetaSchema),
  /** provider slug → window → ring */
  rings: z.record(
    z.string(),
    z.record(z.string(), SeriesRingSchema),
  ),
});
export type WorkerState = z.infer<typeof WorkerStateSchema>;

/** The stored blob. `bench` is the exact shape the site consumes
 *  (extras.series* already projected from the rings at publish time),
 *  so the read path is: GET pointer, GET blob, serve bench. */
export const MaterializedSnapshotSchema = z.object({
  v: z.literal(MAT_SCHEMA_VERSION),
  slug: z.string(),
  /** filterSig of the variant; "" for the unfiltered aggregate. */
  sig: z.string(),
  builtAt: z.number(),
  sweepMs: z.number().optional(),
  bench: z.unknown(),
  state: WorkerStateSchema,
});
export type MaterializedSnapshot = Omit<
  z.infer<typeof MaterializedSnapshotSchema>,
  "bench"
> & { bench: Benchmark };

export function parseSnapshot(raw: string): MaterializedSnapshot | null {
  try {
    const parsed = MaterializedSnapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data as MaterializedSnapshot;
  } catch {
    return null;
  }
}
