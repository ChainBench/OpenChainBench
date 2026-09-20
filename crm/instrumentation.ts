/**
 * The refresher. One interval per server process: a refresh at boot when
 * the stored snapshot is older than the interval, then every REFRESH_MINUTES
 * with a little jitter so two instances would not align on PostHog.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.CRM_DISABLE_SCHEDULER === "1") return;
  const { readSnapshot, refreshSnapshot, REFRESH_MINUTES, snapshotAgeMinutes } = await import("@/lib/snapshot");
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
