import curveFile from "@/data/wallet-cost-curves.json";

/**
 * The reader for the wallet-cost curve.
 *
 * The gauges price every embedded wallet provider at three volumes (1k, 10k
 * and 100k monthly active users) because a Prometheus series needs a fixed
 * label. This artifact is the same model evaluated along the whole range,
 * so the calculator can price any app size. Same design as bench 282's
 * reader (src/lib/rpc-cost-curve.ts) and for the same reason: the arithmetic
 * stays in the harness, and this file only reads between the points it
 * emitted, so the page and the gauges cannot disagree about a price.
 *
 * Interpolation is exact. For a fixed profile every billed quantity is
 * linear in MAU, so each plan's bill is piecewise linear, and the emitter
 * puts a point at every tier boundary, cap, quote threshold, minimum-fee
 * kink and plan crossover. An independent scorer re-prices a million random
 * MAU counts against this file before it is committed.
 *
 * Regenerate after any catalogue edit, from `harnesses/wallet-cost`:
 *
 *   WALLET_COST_EMIT_CURVES=../../src/data/wallet-cost-curves.json go run ./cmd/script
 *
 * `pnpm validate` fails when the file was built from a catalogue whose bytes
 * differ from the committed one.
 */

/** Bumped with `Schema` in harnesses/wallet-cost/cmd/script/curve.go. */
export const WALLET_COST_CURVE_SCHEMA = 1;

export type WalletCostPoint = {
  /** Monthly active users. */
  u: number;
  /** Monthly bill in USD, or null where no published plan serves it. */
  usd: number | null;
  /** Cheapest plan at exactly this MAU. Present with a price. */
  plan?: string;
  /** Cheapest plan on the open segment to the next point. */
  next?: string;
  /** Why there is no price. Present without one. */
  why?: string;
  /** The price at this point is one reading of an ambiguous page. */
  unc?: boolean;
  /** The same for the open segment to the next point. */
  nextUnc?: boolean;
};

export type WalletCostProvider = {
  slug: string;
  name: string;
  /** What the vendor bills, in words: "Monthly active users plus signatures". */
  unit: string;
  points: WalletCostPoint[];
};

export type WalletCostProfile = {
  id: string;
  label: string;
  txPerUser: number;
  newUserShare: number;
  providers: WalletCostProvider[];
};

export type WalletCostFile = {
  schema: number;
  catalogueVersion: number;
  catalogueAsOf: string;
  catalogueSha256: string;
  floor: number;
  ceiling: number;
  volumes: { id: string; mau: number }[];
  headline: { profile: string; volume: string };
  planNames: Record<string, Record<string, string>>;
  notes: Record<string, string>;
  excluded: { slug: string; name: string; reason: string }[];
  profiles: WalletCostProfile[];
  generatedBy: string;
};

const file = curveFile as unknown as WalletCostFile;

/** The artifact, or null when its shape is one this build does not know. */
export function walletCostCurves(): WalletCostFile | null {
  return file.schema === WALLET_COST_CURVE_SCHEMA ? file : null;
}

export function walletCostProfile(id: string): WalletCostProfile | null {
  return walletCostCurves()?.profiles.find((p) => p.id === id) ?? null;
}

export type WalletCostQuote =
  | { usd: number; plan: string; uncertain: boolean }
  | { usd: null; reason: string };

/**
 * The monthly bill for this provider at this MAU count. A gap stays null
 * with the provider's own reason: "cannot serve this" must never read as
 * "costs nothing".
 */
export function walletCostQuoteAt(p: WalletCostProvider, mau: number): WalletCostQuote {
  const pts = p.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return { usd: null, reason: "no published pricing" };
  if (mau <= first.u) return quoteOf(first);
  if (mau >= last.u) return quoteOf(last);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b || mau < a.u || mau > b.u) continue;
    if (mau === a.u) return quoteOf(a);
    if (mau === b.u) return quoteOf(b);
    // One end unpriced: the provider stops somewhere in this segment. The
    // emitter places a second point a hair past every cap, so this segment
    // is that hair, and the reading past the cap is the unpriced end's.
    if (a.usd === null) return quoteOf(a);
    if (b.usd === null) return quoteOf(b);
    const t = (mau - a.u) / (b.u - a.u);
    return {
      usd: a.usd + t * (b.usd - a.usd),
      plan: a.next ?? a.plan ?? "",
      uncertain: Boolean(a.nextUnc),
    };
  }
  return { usd: null, reason: "no published pricing" };
}

function quoteOf(p: WalletCostPoint): WalletCostQuote {
  if (p.usd === null || p.usd === undefined) return { usd: null, reason: p.why || "not available" };
  return { usd: p.usd, plan: p.plan ?? "", uncertain: Boolean(p.unc) };
}

export type WalletCostRow = {
  slug: string;
  name: string;
  unit: string;
  usd: number | null;
  plan: string;
  planName: string;
  /** False when the catalogue states a caveat on this plan's price. */
  verified: boolean;
  reason: string;
};

/**
 * Every provider at one profile and MAU, cheapest first, with the unpriced
 * ones returned separately so no caller can sort a missing price in among
 * the real ones.
 */
export function walletCostRankAt(
  profileId: string,
  mau: number,
): { priced: WalletCostRow[]; unpriced: WalletCostRow[] } {
  const f = walletCostCurves();
  const profile = walletCostProfile(profileId);
  if (!f || !profile) return { priced: [], unpriced: [] };
  const priced: WalletCostRow[] = [];
  const unpriced: WalletCostRow[] = [];
  for (const p of profile.providers) {
    const q = walletCostQuoteAt(p, mau);
    const row: WalletCostRow = {
      slug: p.slug,
      name: p.name,
      unit: p.unit,
      usd: q.usd,
      plan: q.usd === null ? "" : q.plan,
      planName: q.usd === null ? "" : (f.planNames[p.slug]?.[q.plan] ?? q.plan),
      verified: q.usd === null ? true : !q.uncertain,
      reason: q.usd === null ? q.reason : "",
    };
    (q.usd === null ? unpriced : priced).push(row);
  }
  // Bills are compared at the cent: two plans a fraction of a cent apart
  // after interpolation are a tie, and a tie is ordered by name so the list
  // does not shuffle as the slider moves.
  priced.sort(
    (a, b) =>
      Math.round((a.usd ?? 0) * 100) - Math.round((b.usd ?? 0) * 100) ||
      a.name.localeCompare(b.name),
  );
  unpriced.sort((a, b) => a.name.localeCompare(b.name));
  return { priced, unpriced };
}
