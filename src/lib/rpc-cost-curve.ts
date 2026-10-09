import curveFile from "@/data/rpc-cost-curves.json";

/**
 * The reader for bench 282's cost curve.
 *
 * The gauges price every provider at exactly three volumes, because a
 * Prometheus series needs a fixed label: 10M, 100M and 1B requests a month.
 * A reader whose workload is 40M, or 3B, has no row. This artifact is
 * the same model evaluated along the whole range, so a slider has something
 * to read.
 *
 * What is committed is the CURVE, not the pricing parameters. Recomputing in
 * the browser was the obvious design and it is wrong: eligibility moves with
 * volume (daily caps a monthly total passes silently, `hard_stop` overage
 * that makes a plan unbuyable rather than merely expensive, plans that carry
 * a prerequisite's price, banded overage rates). A TypeScript reimplementation
 * would be a second pricing engine, and the two would eventually disagree
 * about what a provider charges. That is the failure this bench exists to
 * avoid, so the arithmetic stays in the harness and this file only reads
 * between the points it emitted.
 *
 * Interpolation is exact, not smoothing: between two adjacent emitted points
 * the bill is affine in the request count, because units scale linearly with
 * requests and the overage rate is constant inside one band. The emitter puts
 * a point at every corner — allowance ceilings, band edges, plan crossovers,
 * each added node in the dedicated cohort — and `harnesses/rpc-cost` tests
 * the result against the model at the three volumes the gauges publish.
 *
 * Regenerate after any catalogue edit, from `harnesses/rpc-cost`:
 *
 *   RPC_COST_EMIT_CURVES=../../src/data/rpc-cost-curves.json go run ./cmd/script
 *
 * `pnpm validate` fails if the artifact's catalogue version or date has
 * fallen behind `harnesses/rpc-cost/pricing/catalogue.yml`, because a stale
 * curve is a price the bench no longer stands behind.
 */

/**
 * Bumped whenever the artifact's shape changes. The reader refuses a shape it
 * does not know rather than decoding missing fields into zeros: a `usd` that
 * silently reads 0 is the $0-leader bug again, one layer down.
 */
export const RPC_COST_CURVE_SCHEMA = 1;

export type RpcCostCurvePoint = {
  /** Requests a month. */
  r: number;
  /** Monthly bill in USD, or null where no plan of this provider serves it. */
  usd: number | null;
  /** The plan that is cheapest at this volume. Present with a price. */
  plan?: string;
  /** Why there is no price. Present without one. */
  why?: string;
};

export type RpcCostCurveProvider = {
  slug: string;
  name: string;
  /** `usage` or `dedicated`. The excluded and reference rows are not emitted. */
  cohort: string;
  /** What the provider meters: request, cu, credit, ru, billing_unit. */
  unit: string;
  points: RpcCostCurvePoint[];
};

export type RpcCostCurveProfile = {
  id: string;
  label: string;
  chain: string;
  providers: RpcCostCurveProvider[];
};

export type RpcCostCurveFile = {
  schema: number;
  catalogueVersion: number;
  catalogueAsOf: string;
  floor: number;
  ceiling: number;
  profiles: RpcCostCurveProfile[];
  generatedBy: string;
};

const file = curveFile as RpcCostCurveFile;

/**
 * The artifact, or null when its shape is one this build does not understand.
 *
 * Null rather than a throw: a schema mismatch can only happen if the Go
 * constant and this one were bumped apart, which `pnpm validate` catches in
 * CI. Letting the page render without the slider is a visible absence; a
 * thrown error takes down a bench page that is otherwise entirely correct.
 */
export function rpcCostCurves(): RpcCostCurveFile | null {
  return file.schema === RPC_COST_CURVE_SCHEMA ? file : null;
}

/** The span the slider may cover. Below the floor every plan is its base price. */
export function rpcCostCurveRange(): { floor: number; ceiling: number } | null {
  const f = rpcCostCurves();
  return f ? { floor: f.floor, ceiling: f.ceiling } : null;
}

/**
 * One workload's curves. The page passes a single profile to the client, not
 * the whole file: all five together are 159 KB, and a reader on the dapp tab
 * has no use for the trace numbers.
 */
export function rpcCostCurveProfile(id: string): RpcCostCurveProfile | null {
  return rpcCostCurves()?.profiles.find((p) => p.id === id) ?? null;
}

export function rpcCostCurveProfileIds(): string[] {
  return rpcCostCurves()?.profiles.map((p) => p.id) ?? [];
}

export type RpcCostQuote =
  | { usd: number; plan: string }
  | { usd: null; reason: string };

/**
 * The monthly bill for this provider at this request count.
 *
 * A gap stays null and carries the provider's own reason. The board shipped
 * five providers at $0 above its own leader once, because an absent reading
 * rendered as a free plan; every caller here has to be able to tell "costs
 * nothing" from "cannot serve this".
 */
export function rpcCostQuoteAt(
  provider: RpcCostCurveProvider,
  requests: number,
): RpcCostQuote {
  const pts = provider.points;
  if (pts.length === 0) return { usd: null, reason: "no published pricing" };

  // Outside the emitted span the honest answer is the nearest endpoint, which
  // is what the emitter's floor and ceiling mean: below 100k every plan is its
  // base price, and above 5B the cohort is enterprise quotes nobody publishes.
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return { usd: null, reason: "no published pricing" };
  if (requests <= first.r) return quoteOf(first);
  if (requests >= last.r) return quoteOf(last);

  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b || requests < a.r || requests > b.r) continue;

    // One end unpriced means the provider stops serving somewhere inside this
    // segment, and the emitter could not say where. Interpolating would draw
    // a line from a real price to nothing.
    if (a.usd === null) return quoteOf(a);
    if (b.usd === null) return quoteOf(b);

    const span = b.r - a.r;
    const t = span === 0 ? 0 : (requests - a.r) / span;
    const usd = a.usd + t * (b.usd - a.usd);
    // Inside a segment the plan is constant, except across the pair that
    // brackets a crossover, where it changes by construction. Report the
    // nearer end's plan; the pair spans a fraction of a percent of volume.
    const plan = (t < 0.5 ? a.plan : b.plan) ?? a.plan ?? b.plan ?? "";
    return { usd, plan };
  }

  return { usd: null, reason: "no published pricing" };
}

function quoteOf(p: RpcCostCurvePoint): RpcCostQuote {
  if (p.usd === null) return { usd: null, reason: p.why || "not available" };
  return { usd: p.usd, plan: p.plan ?? "" };
}

export type RpcCostRankedRow = {
  slug: string;
  name: string;
  cohort: string;
  unit: string;
  usd: number | null;
  plan: string;
  reason: string;
};

/**
 * Every provider in one workload at one volume, cheapest first, with the
 * unpriced ones kept but held behind the priced ones.
 *
 * They are kept because "Helius publishes no Ethereum plan" is an answer a
 * reader moving the slider wants to see, and held back because a missing
 * price is not a cheap one. The two groups come back separated rather than
 * sorted together, so no caller can accidentally rank them as equals.
 */
export function rpcCostRankAt(
  profileId: string,
  requests: number,
): { priced: RpcCostRankedRow[]; unpriced: RpcCostRankedRow[] } {
  const profile = rpcCostCurveProfile(profileId);
  if (!profile) return { priced: [], unpriced: [] };

  const priced: RpcCostRankedRow[] = [];
  const unpriced: RpcCostRankedRow[] = [];

  for (const provider of profile.providers) {
    const q = rpcCostQuoteAt(provider, requests);
    const row: RpcCostRankedRow = {
      slug: provider.slug,
      name: provider.name,
      cohort: provider.cohort,
      unit: provider.unit,
      usd: q.usd,
      plan: q.usd === null ? "" : q.plan,
      reason: q.usd === null ? q.reason : "",
    };
    (q.usd === null ? unpriced : priced).push(row);
  }

  priced.sort((a, b) => (a.usd ?? 0) - (b.usd ?? 0) || a.slug.localeCompare(b.slug));
  unpriced.sort((a, b) => a.name.localeCompare(b.name));
  return { priced, unpriced };
}
