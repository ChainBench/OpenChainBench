import curveFile from "@/data/paymaster-cost-curves.json";

/**
 * The reader for bench 312's curve: what each vendor bills a developer for
 * sponsoring gas, beyond the gas itself, per chain (a scenario), along
 * sponsored user operations a month.
 *
 * Same contract as src/lib/wallet-cost-curve.ts: the arithmetic stays in the
 * harness, this file only reads between the points it emitted, and the
 * emitter puts a point at every corner, so interpolation is exact. An
 * independent scorer re-prices every point and 990,000 random sizes before
 * the file is committed, and `pnpm validate` re-runs it.
 *
 * Regenerate after any catalogue edit, from `harnesses/paymaster-cost`:
 *
 *   PAYMASTER_COST_EMIT_CURVES=../../src/data/paymaster-cost-curves.json go run ./cmd/script
 */

/** Bumped with `Schema` in harnesses/paymaster-cost/cmd/script/curve.go. */
export const PAYMASTER_COST_CURVE_SCHEMA = 1;

export type Bound = "upper" | "lower" | "";

export type PaymasterPoint = {
  /** The scenario's axis value. */
  x: number;
  usd: number | null;
  plan?: string;
  next?: string;
  why?: string;
  unc?: boolean;
  nextUnc?: boolean;
  /** "upper": the priced reading is the higher one, the bill is at most this. */
  bound?: Bound;
  nextBound?: Bound;
};

export type PaymasterProvider = {
  slug: string;
  name: string;
  unit: string;
  points: PaymasterPoint[];
};

export type PaymasterScenario = {
  id: string;
  label: string;
  /** What x counts: "sponsored user operations a month". */
  axis: string;
  walletsFixed: number;
  walletsPerX: number;
  txFixed: number;
  txPerX: number;
  /** USD of gas one sponsored operation burns on this chain (measured). */
  gasUsdPerTx: number;
  floor: number;
  ceiling: number;
  sizes: { id: string; x: number }[];
  providers: PaymasterProvider[];
};

export type PaymasterFile = {
  schema: number;
  catalogueVersion: number;
  catalogueAsOf: string;
  catalogueSha256: string;
  headline: { scenario: string; size: string };
  planNames: Record<string, Record<string, string>>;
  notes: Record<string, string>;
  excluded: { slug: string; name: string; reason: string }[];
  scenarios: PaymasterScenario[];
  generatedBy: string;
};

const file = curveFile as unknown as PaymasterFile;

export function paymasterCurves(): PaymasterFile | null {
  return file.schema === PAYMASTER_COST_CURVE_SCHEMA ? file : null;
}

export function paymasterScenario(id: string): PaymasterScenario | null {
  return paymasterCurves()?.scenarios.find((s) => s.id === id) ?? null;
}

/**
 * Operations a scenario implies at x, and the gas they burn: the same at
 * every vendor, so it is outside every bill and shown beside it.
 */
export function paymasterWorkload(s: PaymasterScenario, x: number): { ops: number; gasUSD: number } {
  const ops = s.txFixed + s.txPerX * x;
  return { ops, gasUSD: ops * s.gasUsdPerTx };
}

export type PaymasterQuote =
  | { usd: number; plan: string; uncertain: boolean; bound: Bound }
  | { usd: null; reason: string };

export function paymasterQuoteAt(p: PaymasterProvider, x: number): PaymasterQuote {
  const pts = p.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return { usd: null, reason: "no published pricing" };
  if (x <= first.x) return quoteOf(first);
  if (x >= last.x) return quoteOf(last);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b || x < a.x || x > b.x) continue;
    if (x === a.x) return quoteOf(a);
    if (x === b.x) return quoteOf(b);
    if (a.usd === null || a.usd === undefined) return quoteOf(a);
    if (b.usd === null || b.usd === undefined) return quoteOf(b);
    const t = (x - a.x) / (b.x - a.x);
    return {
      usd: a.usd + t * (b.usd - a.usd),
      plan: a.next ?? a.plan ?? "",
      uncertain: Boolean(a.nextUnc),
      bound: a.nextBound ?? "",
    };
  }
  return { usd: null, reason: "no published pricing" };
}

function quoteOf(p: PaymasterPoint): PaymasterQuote {
  if (p.usd === null || p.usd === undefined) return { usd: null, reason: p.why || "not available" };
  return { usd: p.usd, plan: p.plan ?? "", uncertain: Boolean(p.unc), bound: p.bound ?? "" };
}

export type PaymasterRow = {
  slug: string;
  name: string;
  unit: string;
  usd: number | null;
  plan: string;
  planName: string;
  verified: boolean;
  /** For an uncertain price: "upper" = at most this, "lower" = at least. */
  bound: Bound;
  reason: string;
};

export function paymasterRankAt(
  scenarioId: string,
  x: number,
): { priced: PaymasterRow[]; unpriced: PaymasterRow[] } {
  const f = paymasterCurves();
  const s = paymasterScenario(scenarioId);
  if (!f || !s) return { priced: [], unpriced: [] };
  const priced: PaymasterRow[] = [];
  const unpriced: PaymasterRow[] = [];
  for (const p of s.providers) {
    const q = paymasterQuoteAt(p, x);
    const row: PaymasterRow = {
      slug: p.slug,
      name: p.name,
      unit: p.unit,
      usd: q.usd,
      plan: q.usd === null ? "" : q.plan,
      planName: q.usd === null ? "" : (f.planNames[p.slug]?.[q.plan] ?? q.plan),
      verified: q.usd === null ? true : !q.uncertain,
      bound: q.usd === null ? "" : q.bound,
      reason: q.usd === null ? q.reason : "",
    };
    (q.usd === null ? unpriced : priced).push(row);
  }
  priced.sort(
    (a, b) =>
      Math.round((a.usd ?? 0) * 100) - Math.round((b.usd ?? 0) * 100) ||
      a.name.localeCompare(b.name),
  );
  unpriced.sort((a, b) => a.name.localeCompare(b.name));
  return { priced, unpriced };
}

/**
 * The row the calculator may name as cheapest: the first priced row whose
 * price holds under every reading of its page. A verified price does; an
 * uncertain one that is an UPPER bound does too, since its true bill is at
 * most the figure and it is already the lowest. A lower bound does not.
 */
export function paymasterLeader(priced: PaymasterRow[]): PaymasterRow | undefined {
  return priced.find((r) => r.verified || r.bound === "upper");
}
