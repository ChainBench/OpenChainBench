/**
 * Whether a row may take a rank, given its spec's `ranked` query.
 *
 * A spec that declares `ranked` is saying eligibility must be ESTABLISHED, so
 * there are three outcomes and only one of them is a rank:
 *
 *	gate > 0   eligible, ranked
 *	gate <= 0  measured, published, listed below the ranked rows
 *	gate null  we did not find out, which is not eligibility
 *
 * The third used to fall through to a rank. `prom.scalar` returns null for a
 * failed query and for an empty result alike, so one timed-out query promoted
 * the row it was meant to hold back: on bench 311 that put Alchemy first at
 * 12 of 12 cells = 100.00%, above BlockMachine's measured 95.92 over 49. The
 * caller retries once before asking this, for the same reason the percentiles
 * retry, so a transient null does not gate an eligible provider.
 */
export function rankGateLabel(
  ranked: string | undefined,
  gate: number | null | undefined,
): "Provisional" | undefined {
  if (!ranked) return undefined;
  if (gate == null || !Number.isFinite(gate)) return "Provisional";
  return gate <= 0 ? "Provisional" : undefined;
}
