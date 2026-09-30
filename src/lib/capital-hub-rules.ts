/**
 * Pure display and selection rules of the /capital hub, shared by the
 * server loader (capital-hub.ts), the client tables (capital-hub-tabs.tsx),
 * the Markdown view and the JSON endpoint, so every surface applies one
 * rule and the tests exercise the rule once. No server imports.
 */

import { fmtPct, fmtUsdShort, fmtX, type OiRow } from "@/lib/capital-hub-types";

/* ---------------------------------------------------------------- dust */

/**
 * DeFiLlama answers 0 (or a few dollars) for a chain it does not track, so
 * a level under this floor is not a measurement of the chain: it renders as
 * a muted "<$1K" and sorts as 0. Levels only (TVL, float, DEX volume, fees,
 * revenue); a flow keeps its sign and its digits, a bridged value comes from
 * L2Beat, which lists nothing it does not track.
 */
export const DUST_USD = 1_000;

export function isDust(v: number | null): boolean {
  return v != null && Number.isFinite(v) && Math.abs(v) < DUST_USD;
}

/** A USD level for the tables: n/a when missing, "<$1K" under the dust floor. */
export function fmtUsdLevel(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return isDust(v) ? "<$1K" : fmtUsdShort(v);
}

/** Sort key of a level: dust sorts as 0 so "<$1K" never outranks a real value. */
export function levelSortValue(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return isDust(v) ? 0 : v;
}

/* ------------------------------------------------------- 7d vs median */

/**
 * Bench 273 publishes the chain's 7d move and its excess over the cohort
 * median (chain_tvs_change_7d_excess_pct); the median itself is a no-label
 * gauge the bench does not carry per row, so it is recovered as move minus
 * excess.
 */
export function median7dPct(change7dPct: number | null, excess7dPct: number | null): number | null {
  if (change7dPct == null || excess7dPct == null) return null;
  if (!Number.isFinite(change7dPct) || !Number.isFinite(excess7dPct)) return null;
  return change7dPct - excess7dPct;
}

/** The sub-line under "7d vs L2 median": `chain +8.7%, median +4.7%`, or null when either side is missing. */
export function sevenDaySubline(change7dPct: number | null, medianPct: number | null): string | null {
  if (change7dPct == null || medianPct == null) return null;
  return `chain ${fmtPct(change7dPct)}, median ${fmtPct(medianPct)}`;
}

/* ----------------------------------------------------- bridged share */

/** "NN% bridged" only when it says something: a share at or above 90% is the normal case for an L2 and is left out. */
export function bridgedShareSubline(sharePct: number | null): string | null {
  if (sharePct == null || !Number.isFinite(sharePct)) return null;
  // The threshold applies to the printed digits: 89.6 prints "90%" and stays out.
  const shown = Math.round(sharePct);
  return shown < 90 ? `${shown}% bridged` : null;
}

/* ---------------------------------------------- the four cell states */

/**
 * A cell of the capital tables is one of four things, and a reader has to
 * be able to tell them apart without a mouse:
 *  - value: ranked by the bench that owns the column;
 *  - outside: the bench loaded, the row is not in its cohort, and the daily
 *    history still carries a number: shown muted, never ranked, counted or
 *    crowned;
 *  - na: not applicable, with the reason why there is no number to show and
 *    never will be (Ethereum is the chain the bridges start from, Circle
 *    runs no CCTP domain here, DeFiLlama publishes no fee adapter). The
 *    cell prints a dash carrying a superscript marker, and the marker is
 *    what tells it apart: the legend under the table spells out the reason;
 *  - unknown: the feed should carry a value for this row and does not (a
 *    withheld row, a bench that failed to load this render). The cell
 *    prints "n/a" and nothing else.
 *
 * "n/a" is the missing value here because it is the missing value
 * everywhere else on the site (perp head to head, the trading-app charts,
 * the RPC tables, the fee comparison), and a token cannot mean two things
 * on two pages. The inapplicable case gets its own rendering instead, as it
 * already does on the fee comparison page.
 *
 * This is the bench 208 rule applied to a table: an absent measurement must
 * not read as a measured absence.
 */
export type CohortCell =
  | { kind: "value"; value: number }
  | { kind: "outside"; value: number }
  | { kind: "na"; reason: string }
  | { kind: "unknown" };

export const OUTSIDE_COHORT_LABEL = "outside the ranked cohort";

/** What a plain "n/a" means here, for the legend and the cell title: the same thing it means everywhere else on the site. */
export const UNKNOWN_LABEL = "the feed carries no value for this row on this run";

/** What a dash with a marker means, said once in the legend of every table that has one. */
export const NOT_APPLICABLE_LABEL = "the column does not apply to this row, and the letter says why";

/**
 * Why a column can have no value for a row and never will. Every string is
 * specific enough to be checked against the source: it names the chain's
 * position (source of the bridges, sovereign L1), the deployment (no CCTP
 * domain) or the missing adapter. Computed in src/lib/capital-hub.ts from
 * the cohort flags the benches already publish, never guessed in the view.
 */
export const NA_REASON = {
  bridgedSource: "source chain, not a bridge destination",
  bridgedSovereign: "sovereign L1, not in the bridged cohort",
  stablesNone: "DeFiLlama publishes no stablecoin float for this chain",
  feesNone: "DeFiLlama publishes no chain fees adapter for this chain",
  cctpNone: "CCTP not deployed on this chain",
  cctpUnscanned: "CCTP domain outside the chains bench 281 scans as a source",
  perpVolumeNone: "the venue publishes no 24h volume to the perp cohort harness",
  perpOiNone: "the venue publishes no open interest to the perp cohort harness",
  perpTurnoverNone: "the venue publishes no open interest to the perp cohort harness, so volume over open interest is undefined",
  perpOiNoSeries: "no 7-day series for this gauge: a 7-day move would have to come from a different measurement than the level",
  oiSeriesMissing: "no 7-day series for this row",
  oiSeriesShort: "the 7-day window is not covered: the series starts inside it",
  oiSeriesFlat: "fewer than two readings in the 7-day window",
  oiSeriesStep: "the series steps more than 2x inside the window: a change in what the venue reports, not a 7-day move",
  categoryTooSmall: "category too small for a peer median: under five ranked protocols, the ratio compares the token with at most three others",
} as const;

export function cohortCell(
  inCohort: boolean,
  ranked: number | null,
  outside: number | null,
  /** Why the column does not apply to this row at all; null when a missing value would be unknown, not inapplicable. */
  naReason: string | null = null,
): CohortCell {
  if (inCohort) return ranked != null && Number.isFinite(ranked) ? { kind: "value", value: ranked } : { kind: "unknown" };
  if (outside != null && Number.isFinite(outside)) return { kind: "outside", value: outside };
  return naReason ? { kind: "na", reason: naReason } : { kind: "unknown" };
}

/**
 * The number a cohort-gated column would actually print for a row: the ranked
 * value, else the muted out-of-cohort one. What `columnIsWorthShowing` has to
 * count, because a column at 38 ranked plus 20 muted is a full column and a
 * naive null check on the ranked field alone would drop it.
 */
export function printedValue(ranked: number | null, outside: number | null): number | null {
  if (ranked != null && Number.isFinite(ranked)) return ranked;
  return outside != null && Number.isFinite(outside) ? outside : null;
}

/** A value the column does carry, or the reason it never will, or unknown. */
export function plainCell(value: number | null, naReason: string | null): CohortCell {
  if (value != null && Number.isFinite(value)) return { kind: "value", value };
  return naReason ? { kind: "na", reason: naReason } : { kind: "unknown" };
}

/**
 * The legend under a table: every distinct not-applicable reason its cells
 * carry, in the order the columns present them, each with the superscript
 * marker the cell prints next to its dash. Letters rather than digits so a
 * marker is never read as part of the number next to it, and the letter is
 * what separates "does not apply" from the plain "n/a" of a missing value.
 */
export const NA_MARKERS = "abcdefghij";

export function naLegend(reasons: readonly (string | null | undefined)[]): { marker: string; reason: string }[] {
  const seen: string[] = [];
  for (const r of reasons) if (r && !seen.includes(r)) seen.push(r);
  return seen.map((reason, i) => ({ marker: NA_MARKERS[i] ?? "*", reason }));
}

export function naMarker(legend: readonly { marker: string; reason: string }[], reason: string): string {
  return legend.find((e) => e.reason === reason)?.marker ?? "*";
}

/* ------------------------------------------------------------- CCTP */

/**
 * Chains with a Circle CCTP domain, as OpenChainBench slugs, from the
 * bridge-flows harness table (harnesses/bridge-flows/cmd/script/config.go,
 * Circle's supported-blockchains page read 2026-09-25). The harness slug
 * "hyperevm" is the registry's "hyperliquid". A chain outside this set has
 * no CCTP corridor at all and reads a dash; a chain inside it that bench 281
 * does not scan as a source reads a dash too, with its own label; only a
 * scanned chain can read n/a.
 */
export const CCTP_DOMAIN_CHAINS: ReadonlySet<string> = new Set([
  "ethereum",
  "avalanche",
  "optimism",
  "arbitrum",
  "noble",
  "solana",
  "base",
  "polygon",
  "sui",
  "aptos",
  "unichain",
  "linea",
  "codex",
  "sonic",
  "world-chain",
  "monad",
  "sei",
  "bnb",
  "xdc",
  "hyperevm",
  "hyperliquid",
  "ink",
  "plume",
  "starknet",
  "arc",
  "stellar",
  "edge",
  "injective",
  "morph",
  "pharos",
  "cronos",
  "plasma",
  "xlayer",
]);

export type CctpScope = "scanned" | "domain" | "none";

export function cctpScope(slug: string, scanned: ReadonlySet<string>): CctpScope {
  if (scanned.has(slug)) return "scanned";
  return CCTP_DOMAIN_CHAINS.has(slug) ? "domain" : "none";
}

/** Why the CCTP column does not apply to a chain the bench does not scan. */
export const CCTP_SCOPE_LABEL: Record<Exclude<CctpScope, "scanned">, string> = {
  none: NA_REASON.cctpNone,
  domain: NA_REASON.cctpUnscanned,
};

/* ------------------------------------------------------ divergences */

/**
 * Fee growth a row must clear on the 30-day column. The cohort's own median
 * 30-day fee growth was +21.3% on 2026-09-29 (67 ranked protocols), so a row
 * at or under 20% grew no faster than the median protocol did that month and
 * is moving with the field, not against it; the constant is the median
 * rounded down, so it does not drift with one month's reading.
 */
export const SIGNAL_FEE_GROWTH_MIN_PCT = 20;

/**
 * Size a 30-day token move must clear in either direction. Twenty of the 67
 * ranked tokens, the flat middle 30% of the cohort, moved less than 10% over
 * the 30 days to 2026-09-29; inside that band the sign of the move is not a
 * direction, and a token at -1.3% was reading as "token down".
 */
export const SIGNAL_PRICE_MOVE_MIN_PCT = 10;

/**
 * Members a category needs before its median is allowed to qualify a row. A
 * median over two protocols is a comparison with one other protocol, and
 * Yield (2 members) and DEX Aggregator (3) were putting rows on the list on
 * the strength of it. Below this floor the ratio is neither printed as a
 * peer comparison nor used as a gate.
 */
export const SIGNAL_MIN_CATEGORY_MEMBERS = 5;

export type DivergenceCandidate = {
  feeGrowth30dPct: number | null;
  priceChange30dPct: number | null;
  pfVsCategory: number | null;
  /** Ranked protocols in the same category on this board, the reader can count them in the table. */
  categorySize: number;
};

/** True when the category has enough members for its median to be a peer comparison rather than a pair. */
export function categoryMedianUsable(categorySize: number): boolean {
  return categorySize >= SIGNAL_MIN_CATEGORY_MEMBERS;
}

/**
 * Which signal a row carries, or none. Four clauses, not three: the fee leg
 * and the price leg each have to clear the cohort's noise (constants above),
 * the P/F has to sit on the right side of the category median, and the
 * category has to be large enough for that median to mean anything. It is a
 * screen for further reading and it is not the harness's protocol_diverging
 * gauge, which applies the first three clauses at zero and no category
 * floor: this list is the shorter one on purpose.
 */
export function signalOf(r: DivergenceCandidate): SignalKind | null {
  if (r.feeGrowth30dPct == null || r.priceChange30dPct == null || r.pfVsCategory == null) return null;
  if (!categoryMedianUsable(r.categorySize)) return null;
  if (r.feeGrowth30dPct > SIGNAL_FEE_GROWTH_MIN_PCT && r.priceChange30dPct < -SIGNAL_PRICE_MOVE_MIN_PCT && r.pfVsCategory < 1) {
    return "fees-up-token-down";
  }
  if (r.feeGrowth30dPct < -SIGNAL_FEE_GROWTH_MIN_PCT && r.priceChange30dPct > SIGNAL_PRICE_MOVE_MIN_PCT && r.pfVsCategory > 1) {
    return "fees-down-token-up";
  }
  return null;
}

export function isDiverging(r: DivergenceCandidate): boolean {
  return signalOf(r) === "fees-up-token-down";
}

export function selectDivergences<T extends DivergenceCandidate>(rows: T[], limit = 5): T[] {
  return rows
    .filter(isDiverging)
    .sort((a, b) => (b.feeGrowth30dPct ?? 0) - (a.feeGrowth30dPct ?? 0))
    .slice(0, limit);
}

/* ------------------------------------------------------- 7d change */

/** Largest bucket-to-bucket ratio a 7d series may carry and still read as one continuous window. */
export const SERIES_STEP_MAX = 2;

/**
 * Same change off a bench's 7d series (84 buckets over seven days): the
 * first and last finite buckets, and only when the series covers the whole
 * window (first finite bucket inside the first tenth, about the first 16
 * hours), so a bench that started this week does not publish a shorter
 * move as 7d. When there is no number, the reason says which of the four
 * conditions failed, so the cell can print why instead of a bare dash.
 */
export function change7dOfSeries(series: (number | null)[] | undefined): { value: number | null; naReason: string | null } {
  const no = (naReason: string) => ({ value: null, naReason });
  if (!series || series.length < 10) return no(NA_REASON.oiSeriesMissing);
  const firstIdx = series.findIndex((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (firstIdx < 0) return no(NA_REASON.oiSeriesMissing);
  if (firstIdx > Math.floor(series.length / 10)) return no(NA_REASON.oiSeriesShort);
  let lastIdx = -1;
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (typeof v === "number" && Number.isFinite(v)) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx <= firstIdx) return no(NA_REASON.oiSeriesFlat);
  // A step between two adjacent buckets (two hours apart) of more than 2x
  // is a change in what the bench measures (a source or scope switch), not
  // capital moving in a week: the cell says so rather than print it as 7d.
  let prev: number | null = null;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const v = series[i];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    if (prev != null && (v > prev * SERIES_STEP_MAX || v < prev / SERIES_STEP_MAX)) return no(NA_REASON.oiSeriesStep);
    prev = v;
  }
  const a = series[firstIdx] as number;
  const b = series[lastIdx] as number;
  return { value: ((b - a) / a) * 100, naReason: null };
}

/* --------------------------------------------------- reading notes */

/**
 * Three sentences under each table: how to read the main column, the
 * pitfall, what the table does not say. Plain statements, no verdicts.
 * The Markdown view prints the same lines.
 */
export const CAPITAL_READING = {
  chains: [
    "TVL is the value locked in DeFi contracts on the chain today, a level in dollars; the rank follows it, then stablecoin float, then bridged value when a chain has neither.",
    "TVL is DeFiLlama's DeFi TVL and bridged value is L2Beat's value secured, two different measures of two different things; a chain can rank high on one and low on the other. Net stables 30d is a flow and carries a sign, the other columns are levels and do not. Values under $1K are DeFiLlama zeros for chains it does not track, not measured amounts.",
    "The table does not say where the capital came from or whether it stays: a stablecoin inflow can be one issuer's mint, a bridged value can move with the price of the assets locked, and an L1 has no bridged value to report.",
  ],
  tokens: [
    "P/F is market cap over the last 30 days of protocol fees annualized; the column to read it against is vs category, the P/F divided by the fee-weighted median of the token's category, below 1 meaning under that median.",
    "A P/F on an incomplete fee adapter is unranked and absent here, a float under 10% is held out too, and one month of fees is one month: Fees MoM can swing on a single incentive program. The two badges need both legs to clear the cohort's noise (fees more than 20% against the prior month, token more than 10% over 30 days) and the category to hold at least five ranked protocols, so a flat token and a median over two peers no longer qualify a row.",
    "The table does not say whether a multiple should be higher or lower: it does not see token emissions ahead, buybacks, fee switches or where the fees go, only what the market paid per dollar of fees on the day.",
  ],
  perps: [
    "P/F is market cap over annualized trading fees and P/S the same over the protocol's own share of those fees; the gap between the two is the share paid out to liquidity providers and referrers.",
    "Fees 30d and open interest exist for a venue with no token, P/F does not: a pre-launch venue is listed on the bench unranked and is absent here. FDV/F prices unvested supply as already trading, so a low float widens it against P/F.",
    "The table does not say how the fees were earned: incentivized or wash volume counts the same as organic volume in the fee line, and open interest is a level at one instant.",
  ],
  openInterest: [
    "Open interest is the notional of positions open at the last read: for perp DEXes as each venue's own API reports it through the perp cohort harness, the same figure the perps hub shows, and for prediction markets from Polymarket, Kalshi and the venues' own endpoints through bench 277. Turnover next to it is 24h volume over open interest: how many times a venue traded its whole book in a day.",
    "Open interest is a level and turnover is the ratio that makes it readable: two venues can hold the same open interest with one recycling it several times a day and the other holding it for a week. Turnover is read from bench 271, which divides 24-hour averages of the same two gauges, so it does not divide exactly into two columns showing the latest read. DefiLlama's open-interest overview, which bench 265 publishes per protocol, reads differently from the venues on most rows and is not what these columns show.",
    "The table does not say who holds the positions, how leveraged they are, or how much of the open interest is one market or one wallet. A high turnover is not proof of wash trading: incentive programs, maker rebates and short-horizon retail flow raise it too, and the highest row on the table is a venue whose positions are held for under an hour.",
  ],
} as const;

/* ------------------------------------------- perp open interest */

/** What the perp cohort snapshot gives per venue, narrowed to the fields this table reads. */
export type PerpCohortVenue = {
  slug: string;
  name: string;
  venueType: "onchain" | "regulated" | "cex";
  openInterest: number | null;
  volume24h: number | null;
};

/**
 * Rows of the perp open-interest table, from the perp cohort harness rather
 * than from bench 265's DefiLlama panel: the column header claims each
 * venue's open interest, so it reads each venue's own API, which is also what
 * /perps shows and what bench 271's turnover divides.
 *
 * A centralised venue is not a perp DEX and is dropped. A venue already on the
 * prediction-market table is dropped here, because one venue on one page must
 * not print two different open-interest figures. Everything else keeps its row
 * even with no open interest to show, with the reason on the cell: a venue that
 * vanishes from a table is the complaint this whole branch is about.
 */
export function perpOiRows(
  venues: readonly PerpCohortVenue[],
  opts: {
    /** Cohort slug to product slug, so links, logos and the turnover join all agree. */
    productSlug: (cohortSlug: string) => string;
    /** Bench 271's turnover, keyed by product slug. */
    turnoverBy: ReadonlyMap<string, number | null>;
    /** Slugs already shown on another table on the same page. */
    exclude: ReadonlySet<string>;
    /** False when bench 271 did not load, so a missing turnover is unknown rather than inapplicable. */
    turnoverBenchLoaded: boolean;
  },
): OiRow[] {
  const finite = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return venues
    .filter((v) => v.venueType !== "cex" && !opts.exclude.has(opts.productSlug(v.slug)))
    .map((v) => {
      const slug = opts.productSlug(v.slug);
      const turnover = finite(opts.turnoverBy.get(slug));
      const oi = finite(v.openInterest);
      const volume24h = finite(v.volume24h);
      return {
        slug,
        name: v.name,
        oi,
        oiNaReason: oi == null ? NA_REASON.perpOiNone : null,
        volume24h,
        turnover,
        change7dPct: null,
        change7dNaReason: NA_REASON.perpOiNoSeries,
        volumeNaReason: volume24h == null ? NA_REASON.perpVolumeNone : null,
        turnoverNaReason: turnover == null && opts.turnoverBenchLoaded ? NA_REASON.perpTurnoverNone : null,
      };
    })
    // Ranked by open interest, the rows without one last so the rank stays a rank.
    .sort((a, b) => (b.oi ?? -1) - (a.oi ?? -1));
}

/* --------------------------------------------- reading the signals */

export type SignalKind = "fees-up-token-down" | "fees-down-token-up";

/**
 * What each signal implies, what would falsify it, and where to look next.
 * Three short entries per signal, under the divergence table and in the
 * Markdown view. Every claim is checkable from a column on this page or a
 * page named in `next`, and nothing here is a recommendation: the reading
 * says what the three numbers do and do not establish, so a reader who
 * disagrees can see from the same table why.
 */
export const SIGNAL_READING: Record<SignalKind, { title: string; means: string; falsifies: string; next: string }> = {
  "fees-up-token-down": {
    title: "Fees up, token down",
    means:
      "Fees over the last 30 days grew by more than 20% against the prior 30, the token fell by more than 10% over the same days, and market cap per dollar of annualized fees sits under the fee-weighted median of a category with at least five ranked members. The three readings disagree with each other. It is a screen for further reading, not a conclusion, and the table does not say which of the three is early.",
    falsifies:
      "A 30-day fee jump can be one incentive program, one airdrop farm or one large user, and it ends when they do. The reading does not survive a fee series that is one month tall and flat before it, fee growth that revenue did not follow (the protocol passed the fees on), or a float under a fifth of supply, where the multiple is priced on a small part of the token.",
    next:
      "The product page carries the fee and revenue history month by month; bench protocol-pf-ratio carries the category median this row is divided by and every peer measured the same way, so the row is read against the peers rather than alone. Float and Supply 30d in the table below say how much of the supply has already arrived.",
  },
  "fees-down-token-up": {
    title: "Fees down, token up",
    means:
      "Fees over the last 30 days fell by more than 20% against the prior 30, the token rose by more than 10%, and market cap per dollar of annualized fees sits above the median of a category with at least five ranked members. The price moved away from the fee line rather than with it. A screen for further reading, not a conclusion.",
    falsifies:
      "Fees fall for reasons that are not less usage: a quiet month across the whole category, a fee switch that changed what the adapter counts, or one large market closing. Check the category median in the same column, which moves with the whole category, and check whether the adapter's scope changed inside the window before reading the drop as activity.",
    next:
      "The product page for the fee series and the revenue split, bench protocol-pf-ratio for the peer distribution behind the median. P/S next to P/F says how much of the fees the protocol keeps, which is what a multiple on fees alone does not see.",
  },
};

/**
 * The per-row line behind the signal badge: the row's own three numbers,
 * then the one thing that would change the reading. Numbers only, no
 * verdict, so the badge says why it is there without a narrative column.
 */
export function signalRowNote(r: {
  signal: SignalKind | null;
  feeGrowth30dPct: number | null;
  priceChange30dPct: number | null;
  pfVsCategory: number | null;
  category: string;
}): string | null {
  if (r.signal == null) return null;
  const cat = r.category || "category";
  const head = `Fees ${fmtPct(r.feeGrowth30dPct, 0)} over 30 days, token ${fmtPct(r.priceChange30dPct, 0)}, price to fees ${fmtX(r.pfVsCategory)} the ${cat} median.`;
  const tail =
    r.signal === "fees-up-token-down"
      ? "One month of fee growth can be one incentive program: check the fee series and whether revenue moved with fees."
      : "One month of fees can fall on a quiet category or an adapter scope change: check the category median and the adapter before reading it as usage.";
  return `${head} ${tail}`;
}

/**
 * Whether an optional column is worth a place in the table: at least half the
 * rows carry a value. A column filled for two rows of seventy-nine paints the
 * table with empty cells and says nothing (the owner's note on the first hub
 * draft, whose chain cohort was seventy-nine rows; it is 63 today), so a
 * source still filling in, or one a rate limit keeps mostly empty, stays
 * hidden until it covers the cohort.
 *
 * Every optional column of the chains table goes through this, on the value
 * that would actually print (`printedValue`), so a column like net USDC over
 * CCTP at 7 of 63 cannot paint 56 markers across a wide table again. A
 * reading that does not cover the cohort is not deleted, it is rendered as
 * its own block over the rows it does cover.
 */
export const COLUMN_COVERAGE = 0.5;

export function columnIsWorthShowing<T>(rows: readonly T[], pick: (r: T) => number | null | undefined): boolean {
  if (rows.length === 0) return false;
  const filled = rows.filter((r) => pick(r) != null).length;
  return filled / rows.length >= COLUMN_COVERAGE;
}
