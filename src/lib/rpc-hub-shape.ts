/**
 * The /rpc hub's data shape, and the two pure transforms over it.
 *
 * Split out of `rpc-hub-stats` so a client component can call them: that
 * module reaches for next/cache, the Upstash store and the spec loader, and
 * a value import from a "use client" file would pull all of it into the
 * browser bundle. This file imports nothing on purpose.
 *
 * `rpc-hub-stats` re-exports everything here, so server callers can keep
 * importing from where they always did.
 */

export type RpcRegionKey = "us-east" | "eu-west" | "sgp";

export const RPC_REGION_KEYS: readonly RpcRegionKey[] = [
  "us-east",
  "eu-west",
  "sgp",
] as const;

export type RpcRegionBest = {
  provider: string;
  providerName: string;
  p50Ms: number;
};

export type RpcHubProvider = {
  provider: string;
  name: string;
  p50Ms: number;
  p90Ms?: number;
  /** Fifth quantile, published only where the spec asks for it. */
  p95Ms?: number;
  p99Ms?: number;
  successPct?: number;
  sampleSize?: number;
  /** p50 per probe region, keyed by region value. */
  regions: Partial<Record<RpcRegionKey, number>>;
  /** The tails per probe region, from each region variant's own blob (the
   *  variant injects `region="<r>"` into the headline queries, so its
   *  p90/p95/p99 are already region-scoped). Separate from `regions` to keep
   *  older blobs, which carry p50 numbers there and nothing else, parseable.
   *  This is what lets the geo view show a tail per edge location instead of
   *  repeating a 3-region figure under a region heading. */
  regionTails?: Partial<
    Record<RpcRegionKey, { p90?: number; p95?: number; p99?: number }>
  >;
  /** Archive block depths this provider supports (subset of the
   *  harness's `depthBuckets` = {300, 7200, 216000, 1296000, 5000000}).
   *  Absent = not measured (Solana / Substrate chains skip archive)
   *  or not yet propagated by the worker. */
  archiveDepth?: { supportedBlocks: number[] };
};

export type RpcHubUnresponsiveProvider = {
  provider: string;
  name: string;
  /** Success rate over 24h (%, 2 decimals). Call counters keep
   *  recording through an outage, so this stays meaningful. */
  successPct?: number;
  sampleSize?: number;
};

export type RpcHubChain = {
  /** Chain slug, e.g. "ethereum". */
  chain: string;
  /** Bench slug, e.g. "ethereum-rpc". */
  slug: string;
  /** Chain display label from the chain registry ("Ethereum"). */
  name: string;
  /** Bench display title (spec.title). */
  benchTitle: string;
  providerCount: number;
  /** Declared results in the spec (live or not); drives the hub link gate. */
  declaredCount?: number;
  /** Cohort providers currently flagged unresponsive on this chain
   *  (probed, all calls failing, no latency). Never part of
   *  best/fastest computations — display-only context. */
  unresponsiveCount?: number;
  /** The unresponsive rows themselves (never ranked). Additive optional
   *  field: old blobs without it still parse. */
  unresponsive?: RpcHubUnresponsiveProvider[];
  best: RpcRegionBest | null;
  /** p90 of the overall best provider (same row as `best`). Optional so old blobs stay parseable. */
  bestP90Ms?: number;
  /** p95 of that same row, where the spec declares one. */
  bestP95Ms?: number;
  /** Max archive block depth supported across ALL providers on this
   *  chain (0 or absent = archive not measured / all providers pruned).
   *  Paired with bestArchiveProviders which names the providers hitting
   *  that max depth — the tooltip in the /rpc hub reads both. */
  bestArchiveDepthBlocks?: number;
  /** Providers whose supported set includes bestArchiveDepthBlocks
   *  (i.e. the ones actually offering the max archive on this chain).
   *  Empty when bestArchiveDepthBlocks is undefined. */
  bestArchiveProviders?: string[];
  /** Best provider per probe region. */
  regions: Partial<Record<RpcRegionKey, RpcRegionBest>>;
  /** Full live provider field, sorted fastest first. */
  providers: RpcHubProvider[];
  /** Leader's 24h latency series, downsampled to <=48 points. */
  series?: number[];
  dataConfidence?: string;
  updatedAt: string;
};

export type RpcHubPivotRow = {
  provider: string;
  name: string;
  chainsCovered: number;
  medianRank: number;
  medianP50Ms: number;
  /** Median 24h success rate across covered chains (%, 2 decimals).
   *  Optional: absent from older blobs and success-less rows. */
  medianSuccessPct?: number;
  /** Failed probes over 24h summed across covered chains:
   *  Σ round(sampleSize × (1 − successPct/100)). Optional (needs
   *  sampleSize; absent from older blobs). */
  errors24h?: number;
  chains: Record<
    string,
    { p50Ms: number; rank: number; successPct?: number; sampleSize?: number }
  >;
};

export type RpcHubCohort = {
  chains: RpcHubChain[];
  providersPivot: RpcHubPivotRow[];
  totals: { chains: number; uniqueProviders: number; regions: number };
};

export type RpcHubSnapshot = RpcHubCohort & {
  /** The API-key cohort (bench blobs at sig `tier=keyed`): the chains
   *  whose spec declares a keyed tier, ranked on their own. Absent on
   *  blobs written before the tier dimension existed and when no keyed
   *  blob resolves yet; the hub then shows the public view alone. */
  keyed?: RpcHubCohort;
  /** The cold-start arm (bench blobs at sig `tier=keyed-cold`): the same
   *  vendors and endpoints as `keyed`, measured on a connection that is
   *  never reused, so DNS, TCP and the TLS handshake are paid on every
   *  call. Ranked on its own and never merged into `keyed`: the two are
   *  different questions (a pooled service against a one-shot client),
   *  and the ordering between vendors is not the same in both. Absent on
   *  blobs written before this arm reached the hub. */
  keyedCold?: RpcHubCohort;
  /** The WebSocket race (benches 296 to 304, slugs `<chain>-rpc-ws`): the same
   *  private providers measured on block delivery instead of request latency.
   *
   *  A separate bench family rather than a tier, so it is read from its own
   *  slugs and not from a variant sig. Its figure is also a different quantity:
   *  milliseconds behind whichever provider pushed that block first, where the
   *  leader reads near zero by construction. The page must label it as a lag
   *  rather than as a latency, or a reader sees "0 ms" and concludes the
   *  provider answers instantly. */
  websocket?: RpcHubCohort;
  generatedAt: string;
};

export const round1 = (v: number) => Math.round(v * 10) / 10;
export const round2 = (v: number) => Math.round(v * 100) / 100;

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function buildPivot(chains: RpcHubChain[]): RpcHubPivotRow[] {
  const acc = new Map<
    string,
    { name: string; chains: RpcHubPivotRow["chains"] }
  >();
  for (const c of chains) {
    c.providers.forEach((p, i) => {
      const entry =
        acc.get(p.provider) ?? { name: p.name, chains: {} };
      entry.chains[c.chain] = {
        p50Ms: p.p50Ms,
        rank: i + 1,
        ...(p.successPct != null ? { successPct: p.successPct } : {}),
        ...(p.sampleSize != null ? { sampleSize: p.sampleSize } : {}),
      };
      acc.set(p.provider, entry);
    });
  }
  const rows: RpcHubPivotRow[] = [...acc.entries()].map(
    ([provider, { name, chains: perChain }]) => {
      const cells = Object.values(perChain);
      // Reliability aggregates over covered chains only. Success is a
      // median (robust to one bad chain); errors are an absolute sum of
      // failed probes, same derivation as the ledger's Errors column.
      const successes = cells
        .map((c) => c.successPct)
        .filter((v): v is number => v != null);
      const errorCells = cells.filter(
        (c) => c.sampleSize != null && c.successPct != null,
      );
      const errors24h = errorCells.reduce(
        (sum, c) =>
          sum + Math.round((c.sampleSize as number) * (1 - (c.successPct as number) / 100)),
        0,
      );
      return {
        provider,
        name,
        chainsCovered: cells.length,
        medianRank: round1(median(cells.map((c) => c.rank))),
        medianP50Ms: round1(median(cells.map((c) => c.p50Ms))),
        ...(successes.length > 0
          ? { medianSuccessPct: round2(median(successes)) }
          : {}),
        ...(errorCells.length > 0 ? { errors24h } : {}),
        chains: perChain,
      };
    },
  );
  // Coverage first (the pivot's whole point), then rank quality.
  return rows.sort(
    (a, b) =>
      b.chainsCovered - a.chainsCovered ||
      a.medianRank - b.medianRank ||
      a.medianP50Ms - b.medianP50Ms,
  );
}

/** Probe-region display names, so the hub, the selector and the column
 *  headers cannot drift apart. */
export const RPC_REGION_LABELS: Record<RpcRegionKey, string> = {
  "us-east": "US-East",
  "eu-west": "EU-West",
  sgp: "Singapore",
};

/**
 * Re-scope a cohort to one probe region.
 *
 * The hub's chain table has always carried three region columns, but each
 * shows only that region's *winner*, and the provider pivot averages the
 * three. So "who is fastest for my users in Singapore, provider by
 * provider" could not be read off the board, even though every number it
 * needs already ships: `RpcHubProvider.regions` holds the per-region p50
 * for every provider on every chain.
 *
 * This takes a cohort and returns the same shape with one region's numbers
 * substituted, which lets the existing tables render a geo view with no new
 * data and no extra fetch.
 *
 * Three things are deliberately dropped rather than carried over, because
 * under a region heading they would read as regional figures when they are
 * not:
 *
 *  - the tails, unless the region variant supplied its own. A provider's
 *    headline `p90Ms` is computed over all three regions, so it must not
 *    appear under a region heading; `regionTails` holds what the variant
 *    measured in that one region, and those substitute cleanly. A cell with
 *    no variant tail goes empty rather than borrowing the 3-region figure.
 *  - a chain where no provider answered from this region: dropped, so a
 *    chain never appears with an empty field.
 *  - `series`: it is the all-region leader's trend. Kept only when the
 *    regional leader is that same provider, otherwise the sparkline would
 *    sit on a row it does not belong to.
 */
export function scopeCohortToRegion(
  view: RpcHubCohort,
  region: RpcRegionKey,
): RpcHubCohort {
  const chains: RpcHubChain[] = [];
  for (const c of view.chains) {
    const providers: RpcHubProvider[] = [];
    for (const p of c.providers) {
      const ms = p.regions?.[region];
      if (ms == null) continue;
      const tail = p.regionTails?.[region];
      providers.push({
        provider: p.provider,
        name: p.name,
        p50Ms: ms,
        ...(tail?.p90 != null ? { p90Ms: tail.p90 } : {}),
        ...(tail?.p95 != null ? { p95Ms: tail.p95 } : {}),
        ...(tail?.p99 != null ? { p99Ms: tail.p99 } : {}),
        ...(p.successPct != null ? { successPct: p.successPct } : {}),
        ...(p.sampleSize != null ? { sampleSize: p.sampleSize } : {}),
        ...(p.archiveDepth ? { archiveDepth: p.archiveDepth } : {}),
        regions: { [region]: ms },
        ...(tail ? { regionTails: { [region]: tail } } : {}),
      });
    }
    if (providers.length === 0) continue;
    providers.sort((a, b) => a.p50Ms - b.p50Ms);
    const leader = providers[0];
    const best: RpcRegionBest = {
      provider: leader.provider,
      providerName: leader.name,
      p50Ms: leader.p50Ms,
    };
    const scoped: RpcHubChain = {
      ...c,
      providers,
      providerCount: providers.length,
      best,
      regions: { [region]: best },
    };
    // The chain's headline tails belong to the 3-region leader; under a
    // region scope they are the regional leader's own, or nothing.
    if (leader.p90Ms != null) scoped.bestP90Ms = leader.p90Ms;
    else delete scoped.bestP90Ms;
    if (leader.p95Ms != null) scoped.bestP95Ms = leader.p95Ms;
    else delete scoped.bestP95Ms;
    if (c.best?.provider !== leader.provider) delete scoped.series;
    chains.push(scoped);
  }
  const providersPivot = buildPivot(chains);
  return {
    ...view,
    chains,
    providersPivot,
    totals: {
      chains: chains.length,
      uniqueProviders: providersPivot.length,
      regions: 1,
    },
  };
}
