/**
 * Node-only half of instrumentation.ts (the file itself is compiled for
 * both runtimes, so Node APIs cannot appear in it directly).
 * The refresher: one interval per server process, a refresh at boot when the
 * stored snapshot is older than the interval, then every REFRESH_MINUTES
 * with a little jitter so two instances would not align on PostHog.
 * Also flushes the log-drain accumulator on shutdown so a redeploy loses
 * nothing.
 */
import { readSnapshot, refreshSnapshot, REFRESH_MINUTES, snapshotAgeMinutes } from "@/lib/snapshot";
import { flush } from "@/lib/vercel-logs";

export async function start(): Promise<void> {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      flush().finally(() => process.exit(0));
    });
  }
  if (process.env.CRM_DISABLE_SCHEDULER === "1") return;
  const snap = await readSnapshot();
  const age = snapshotAgeMinutes(snap);
  const firstDelayMs = age == null || age >= REFRESH_MINUTES ? 5_000 : (REFRESH_MINUTES - age) * 60_000;
  const tick = () => {
    refreshSnapshot("scheduled").catch((e) => console.error("[scheduler]", e));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, REFRESH_MINUTES * 60_000 + Math.floor(Math.random() * 30_000));
  }, firstDelayMs).unref();
  console.log(`[scheduler] first refresh in ${Math.round(firstDelayMs / 1000)} s, then every ${REFRESH_MINUTES} min`);
}
