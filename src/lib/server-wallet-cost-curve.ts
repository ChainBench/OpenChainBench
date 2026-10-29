import curveFile from "@/data/server-wallet-cost-curves.json";

/**
 * The reader for bench 310's curve: what each vendor bills for server and
 * agent wallets, per scenario, along that scenario's own axis (agents, a
 * bot's monthly transactions, payout wallets).
 *
 * Same contract as src/lib/wallet-cost-curve.ts: the arithmetic stays in the
 * harness, this file only reads between the points it emitted, and the
 * emitter puts a point at every corner, so interpolation is exact. An
 * independent scorer re-prices every point and a million random sizes before
 * the file is committed, and `pnpm validate` re-runs it.
 *
 * Regenerate after any catalogue edit, from `harnesses/server-wallet-cost`:
 *
 *   SERVER_WALLET_COST_EMIT_CURVES=../../src/data/server-wallet-cost-curves.json go run ./cmd/script
 */

/** Bumped with `Schema` in harnesses/server-wallet-cost/cmd/script/curve.go. */
export const SERVER_WALLET_COST_CURVE_SCHEMA = 1;

export type Bound = "upper" | "lower" | "";

export type ServerWalletPoint = {
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

export type ServerWalletProvider = {
  slug: string;
  name: string;
  unit: string;
  points: ServerWalletPoint[];
};

export type ServerWalletScenario = {
  id: string;
  label: string;
  /** What x counts: "agents", "transactions a month", "payout wallets". */
  axis: string;
  walletsFixed: number;
  walletsPerX: number;
  txFixed: number;
  txPerX: number;
  floor: number;
  ceiling: number;
  sizes: { id: string; x: number }[];
  providers: ServerWalletProvider[];
};

export type ServerWalletFile = {
  schema: number;
  catalogueVersion: number;
  catalogueAsOf: string;
  catalogueSha256: string;
  headline: { scenario: string; size: string };
  planNames: Record<string, Record<string, string>>;
  notes: Record<string, string>;
  excluded: { slug: string; name: string; reason: string }[];
  scenarios: ServerWalletScenario[];
  generatedBy: string;
};

const file = curveFile as unknown as ServerWalletFile;

export function serverWalletCurves(): ServerWalletFile | null {
  return file.schema === SERVER_WALLET_COST_CURVE_SCHEMA ? file : null;
}

export function serverWalletScenario(id: string): ServerWalletScenario | null {
  return serverWalletCurves()?.scenarios.find((s) => s.id === id) ?? null;
}

/** Wallets and transactions a scenario implies at x. */
export function serverWalletWorkload(s: ServerWalletScenario, x: number): { wallets: number; tx: number } {
  return { wallets: s.walletsFixed + s.walletsPerX * x, tx: s.txFixed + s.txPerX * x };
}

export type ServerWalletQuote =
  | { usd: number; plan: string; uncertain: boolean; bound: Bound }
  | { usd: null; reason: string };

export function serverWalletQuoteAt(p: ServerWalletProvider, x: number): ServerWalletQuote {
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

function quoteOf(p: ServerWalletPoint): ServerWalletQuote {
  if (p.usd === null || p.usd === undefined) return { usd: null, reason: p.why || "not available" };
  return { usd: p.usd, plan: p.plan ?? "", uncertain: Boolean(p.unc), bound: p.bound ?? "" };
}

export type ServerWalletRow = {
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

export function serverWalletRankAt(
  scenarioId: string,
  x: number,
): { priced: ServerWalletRow[]; unpriced: ServerWalletRow[] } {
  const f = serverWalletCurves();
  const s = serverWalletScenario(scenarioId);
  if (!f || !s) return { priced: [], unpriced: [] };
  const priced: ServerWalletRow[] = [];
  const unpriced: ServerWalletRow[] = [];
  for (const p of s.providers) {
    const q = serverWalletQuoteAt(p, x);
    const row: ServerWalletRow = {
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
export function serverWalletLeader(priced: ServerWalletRow[]): ServerWalletRow | undefined {
  return priced.find((r) => r.verified || r.bound === "upper");
}
