import { redisCommand, cohortSnapshotConfigured } from "@/lib/cohort-snapshot";

/**
 * Cluster-wide rate limit for the worker's revalidate hook.
 *
 * The materialize worker publishes every 60 s and used to call
 * /api/internal/revalidate-aggregate after every publish. That route
 * fires revalidateTag("benchmarks"), which marks every ISR page that
 * read bench data as stale: ~880 pages re-rendered on their next hit,
 * every minute, regardless of the `revalidate` each page declares. On
 * Vercel that showed up as x-vercel-cache: STALE on every page and a
 * full render (aggregate fetch + provider index rebuild) per request.
 *
 * The data caches underneath already expire on their own (60-300 s), so
 * the tag purge buys nothing for freshness beyond what the page-level
 * `revalidate` provides. One purge per REVALIDATE_MIN_INTERVAL_SEC is
 * plenty; the rest of the hook calls are acknowledged and dropped.
 *
 * Implemented as SET NX EX on the shared Upstash instance so the limit
 * holds across function instances. Without Upstash (local dev) it falls
 * back to a per-process timestamp, which is enough for one dev server.
 */
const KEY = "ocb:revalidate:aggregate:lock:v1";

let lastLocalPurge = 0;

export const DEFAULT_MIN_INTERVAL_SEC = 600;

/** REVALIDATE_MIN_INTERVAL_SEC, default 600. "0" disables the throttle;
 *  unset, empty or garbage falls back to the default (Number("") is 0,
 *  which would silently disable it). */
export function minIntervalSec(env: string | undefined = process.env.REVALIDATE_MIN_INTERVAL_SEC): number {
  const trimmed = (env ?? "").trim();
  if (trimmed === "") return DEFAULT_MIN_INTERVAL_SEC;
  const raw = Number(trimmed);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_INTERVAL_SEC;
}

/**
 * True when the caller may purge now. Acquiring the slot is what starts
 * the next interval, so a purge that happens right after a throttled
 * call still cannot exceed one per interval.
 */
export async function acquireRevalidateSlot(
  intervalSec: number = minIntervalSec(),
  deps: {
    setNx?: (key: string, ttlSec: number) => Promise<boolean>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  if (intervalSec <= 0) return true;
  const now = deps.now ?? Date.now;
  const setNx = deps.setNx ?? defaultSetNx;
  try {
    if (setNx === defaultSetNx && !cohortSnapshotConfigured()) {
      return localAcquire(intervalSec, now());
    }
    return await setNx(KEY, intervalSec);
  } catch {
    // Upstash unreachable: fail open on the local clock rather than
    // letting a Redis hiccup either block freshness or reopen the storm.
    return localAcquire(intervalSec, now());
  }
}

function localAcquire(intervalSec: number, nowMs: number): boolean {
  if (nowMs - lastLocalPurge < intervalSec * 1000) return false;
  lastLocalPurge = nowMs;
  return true;
}

async function defaultSetNx(key: string, ttlSec: number): Promise<boolean> {
  const r = await redisCommand(["SET", key, "1", "NX", "EX", ttlSec], 2_000);
  return r === "OK";
}

/** Test hook: reset the process-local fallback clock. */
export function _resetLocalThrottle(): void {
  lastLocalPurge = 0;
}
