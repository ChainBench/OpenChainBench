import { isDevOnlyBench } from "@/lib/removed-benches";
/**
 * Reader for the terminal-fill-quality harness output (bench 268): what a
 * swap costs the user on each trading terminal, wallet app or Telegram bot
 * (Solana and the EVM chains they trade on),
 * from sampled user transactions read on-chain and valued at the pool's
 * own state before the trade (reserves, or the previous trade on it).
 *
 * JSON written by the harness to the aggregate dir and served by Caddy at
 * kv.openchainbench.com/aggregate/terminal-fills/fills.json. The site
 * only reads it; nothing here touches Prometheus.
 */

const DEFAULT_URL = "https://kv.openchainbench.com/aggregate/terminal-fills/fills.json";

/** Median and p90; ciLo/ciHi = 95 % bootstrap interval of the median (loss only). */
export type FillQuantiles = { median: number; p90: number; n: number; ciLo?: number; ciHi?: number };

export type TerminalFillStats = {
  slug: string;
  name: string;
  kind: "app" | "bot";
  note?: string;
  /** The product (fomo, gmgn, …) and the chain of this entry: "all" for the product's pooled entry over every chain it trades on, a chain slug for one chain, "funding" for a cross-chain app's bridge leg. */
  product: string;
  chain: string;
  /** Swap attempts the feed saw in the window, failed ones, non-swap notifications (markers, funding). */
  seen: number;
  failed: number;
  nonSwap: number;
  /** The base of the fail rate: the feed's attempts on Solana, the block sample's on the EVM rows, both on a pooled product. */
  attempts: number;
  attemptsFailed: number;
  /** Percent of the terminal's swap attempts that failed on-chain; undefined under 20 seen. */
  failRatePct?: number;
  /** Top error classes among failed attempts (slippage, program codes). */
  failReasons: Record<string, number>;
  /** Cost of failures: sampled failed attempts, median fee they paid (USD), expected burn per successful swap in bps of the median trade. */
  failsSampled: number;
  failCostUsd?: FillQuantiles;
  failOverheadBps?: number;
  parsed: number;
  priced: number;
  /** Priced but outside the plausible loss bounds, excluded from the statistics. */
  flagged: number;
  /** Loss vs the pool's pre-trade state, basis points of the trade; undefined without priced samples. */
  loss?: FillQuantiles;
  /** Median cost components, bps: terminal, network, other, pool (when known); relay on cross-chain rows. */
  components: Partial<Record<"terminal" | "network" | "other" | "pool" | "relay", number>>;
  /** Cross-chain rows: loss by origin chain (bnb, robinhood, base, ethereum, arc). */
  byChain: Record<string, FillQuantiles>;
  tradeUsd?: FillQuantiles;
  /** Share of priced samples by reference source: reserves (exact mid), pool (previous trade). */
  refSrcPct: Record<string, number>;
  /** Sandwich screen (informative, coverage depends on pool activity): screened swaps, hits, share, attacker profit. */
  scanned: number;
  sandwiched: number;
  sandwichPct?: number;
  sandwichProfit?: FillQuantiles;
  /** Median loss by trade-size bucket: under25, 25to250, over250 (from 5 samples). */
  bySize: Partial<Record<"under25" | "25to250" | "over250", FillQuantiles>>;
  buySharePct: number;
  venueSharePct: Record<string, number>;
  quoteSharePct: Record<string, number>;
  /** healthy: enough priced swaps to publish (minPriced); ranked: enough to rank (minRank). */
  healthy: boolean;
  ranked: boolean;
};

/** USD value in and out of a swap: buy = quote spent (fee inside) against tokens at the reference; sell = tokens at the reference against quote received. */
function valueSides(s: Record<string, unknown>): { valueInUsd?: number; valueOutUsd?: number } {
  const userQ = num(s.user_q);
  const tokens = num(s.tokens);
  const ref = num(s.ref_price);
  const q = num(s.quote_usd);
  if (userQ === undefined || q === undefined || q <= 0) {
    // The per-leg amounts left the row when it was cut to halve the
    // payload, so both columns rendered a dash. They are recoverable
    // exactly: loss is 1 - received / given, and the trade base is the
    // given side on either direction, which is what the header says.
    // Deriving them keeps the two columns consistent with the published
    // loss by construction.
    const trade = num(s.trade_usd);
    const loss = num(s.loss_bps);
    if (trade === undefined || trade <= 0) return {};
    if (loss === undefined) return { valueInUsd: trade };
    return { valueInUsd: trade, valueOutUsd: trade * (1 - loss / 1e4) };
  }
  const quoteUsd = Math.abs(userQ) * q;
  const tokenUsd = tokens !== undefined && ref !== undefined && ref > 0 ? tokens * ref * q : undefined;
  // A sale on an EVM chain pays its gas apart from the tokens: the base the harness uses is tokens at the reference plus that gas.
  const gasUsd = typeof s.chain === "string" && s.chain ? (num(s.network_q) ?? 0) * q : 0;
  if (s.side === "sell") return { ...(tokenUsd !== undefined ? { valueInUsd: tokenUsd + gasUsd } : {}), valueOutUsd: quoteUsd };
  return { valueInUsd: quoteUsd, ...(tokenUsd !== undefined ? { valueOutUsd: tokenUsd } : {}) };
}

export type FillSample = {
  sig: string;
  terminal: string;
  /** The pooled row this swap rolls up to, when that is not the terminal
   *  itself. Binance's row is the product; its swaps carry
   *  binance-wallet-base / -ethereum, so without this the row's own audit
   *  table matched none of its transactions. */
  product?: string;
  /** What this row stands for, in attempts. A terminal's rows split its
   *  flow between them, so the summary can weight them the way the
   *  published median does instead of counting each row once. Without
   *  it the two medians on this page disagreed by 25% on pump.fun. */
  w?: number;
  time: number;
  side: "buy" | "sell";
  quote: string;
  venue: string;
  /** Pool instructions of the route that are not on the token (quote → X hops). */
  hops: number;
  /** Cross-chain rows: origin chain, Relay's take in bps, origin deposit hash. */
  chain?: string;
  relayBps?: number;
  inTx?: string;
  tradeUsd: number;
  priced: boolean;
  /** Set when the row is kept out of the statistics (loss outside the plausible bounds). */
  flag?: string;
  refSrc?: string;
  refAgeS?: number;
  /** Route through a third asset (mint) priced from the route's own hop. */
  xMint?: string;
  scanned: boolean;
  sandwich?: { attacker: string; frontSig: string; backSig: string; profitBps: number };
  lossBps?: number;
  poolBps?: number;
  terminalBps: number;
  networkBps: number;
  otherBps?: number;
  /** SOL deposit of the token accounts the swap created (refundable when closed): shown, not in the loss. */
  rentUsd?: number;
  /** The two sides in USD: what the user gave and what the user received (the token side at the reference). */
  valueInUsd?: number;
  valueOutUsd?: number;
};

export type TerminalFills = {
  generatedAt: string;
  windowHours: number;
  methodVersion: number;
  minPriced: number;
  minRank: number;
  solUsd: number;
  method: string;
  terminals: TerminalFillStats[];
  recent: FillSample[];
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function quant(x: unknown): FillQuantiles | undefined {
  if (!isRecord(x)) return undefined;
  const median = num(x.median);
  const p90 = num(x.p90);
  const n = num(x.n);
  if (median === undefined || p90 === undefined || n === undefined) return undefined;
  const ciLo = num(x.ci_lo);
  const ciHi = num(x.ci_hi);
  return { median, p90, n, ...(ciLo !== undefined && ciHi !== undefined ? { ciLo, ciHi } : {}) };
}
function numMap(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isRecord(x)) for (const [k, v] of Object.entries(x)) if (typeof v === "number") out[k] = v;
  return out;
}

function quantMap(x: unknown): Record<string, FillQuantiles> {
  const out: Record<string, FillQuantiles> = {};
  if (!isRecord(x)) return out;
  for (const [k, v] of Object.entries(x)) {
    const q = quant(v);
    if (q) out[k] = q;
  }
  return out;
}

function sizeMap(x: unknown): TerminalFillStats["bySize"] {
  const out: TerminalFillStats["bySize"] = {};
  if (!isRecord(x)) return out;
  for (const k of ["under25", "25to250", "over250"] as const) {
    const q = quant(x[k]);
    if (q) out[k] = q;
  }
  return out;
}

function parse(raw: unknown): TerminalFills | null {
  if (!isRecord(raw) || !Array.isArray(raw.terminals)) return null;
  const terminals: TerminalFillStats[] = [];
  for (const t of raw.terminals) {
    if (!isRecord(t) || typeof t.slug !== "string" || typeof t.name !== "string") continue;
    const comps = numMap(t.components_bps);
    terminals.push({
      slug: t.slug,
      name: t.name,
      kind: t.kind === "bot" ? "bot" : "app",
      product: typeof t.product === "string" && t.product ? t.product : t.slug,
      chain: typeof t.chain === "string" && t.chain ? t.chain : "solana",
      ...(typeof t.note === "string" && t.note ? { note: t.note } : {}),
      seen: num(t.seen) ?? 0,
      failed: num(t.failed) ?? 0,
      nonSwap: num(t.non_swap) ?? 0,
      attempts: num(t.attempts) ?? num(t.seen) ?? 0,
      attemptsFailed: num(t.attempts_failed) ?? num(t.failed) ?? 0,
      ...(num(t.fail_rate_pct) !== undefined ? { failRatePct: num(t.fail_rate_pct) } : {}),
      failReasons: numMap(t.fail_reasons),
      failsSampled: num(t.fails_sampled) ?? 0,
      ...(quant(t.fail_cost_usd) ? { failCostUsd: quant(t.fail_cost_usd) } : {}),
      ...(num(t.fail_overhead_bps) !== undefined ? { failOverheadBps: num(t.fail_overhead_bps) } : {}),
      parsed: num(t.parsed) ?? 0,
      priced: num(t.priced) ?? 0,
      flagged: num(t.flagged) ?? 0,
      ...(quant(t.loss_bps) ? { loss: quant(t.loss_bps) } : {}),
      components: {
        ...(comps.terminal !== undefined ? { terminal: comps.terminal } : {}),
        ...(comps.network !== undefined ? { network: comps.network } : {}),
        ...(comps.other !== undefined ? { other: comps.other } : {}),
        ...(comps.pool !== undefined ? { pool: comps.pool } : {}),
        ...(comps.relay !== undefined ? { relay: comps.relay } : {}),
      },
      byChain: quantMap(t.by_chain),
      ...(quant(t.trade_usd) ? { tradeUsd: quant(t.trade_usd) } : {}),
      refSrcPct: numMap(t.ref_src_pct),
      scanned: num(t.scanned) ?? 0,
      sandwiched: num(t.sandwiched) ?? 0,
      ...(num(t.sandwich_pct) !== undefined ? { sandwichPct: num(t.sandwich_pct) } : {}),
      ...(quant(t.sandwich_profit_bps) ? { sandwichProfit: quant(t.sandwich_profit_bps) } : {}),
      bySize: sizeMap(t.by_size),
      buySharePct: num(t.buy_share_pct) ?? 0,
      venueSharePct: numMap(t.venue_share_pct),
      quoteSharePct: numMap(t.quote_share_pct),
      healthy: t.healthy === true,
      ranked: t.ranked === true,
    });
  }
  const recent: FillSample[] = [];
  if (Array.isArray(raw.recent)) {
    for (const s of raw.recent) {
      if (!isRecord(s) || typeof s.sig !== "string" || typeof s.terminal !== "string") continue;
      const sw = isRecord(s.sandwich) ? s.sandwich : null;
      recent.push({
        sig: s.sig,
        terminal: s.terminal,
        ...(typeof s.product === "string" && s.product ? { product: s.product } : {}),
        ...(num(s.w) !== undefined ? { w: num(s.w) } : {}),
        time: num(s.time) ?? 0,
        side: s.side === "sell" ? "sell" : "buy",
        quote: typeof s.quote === "string" ? s.quote : "SOL",
        venue: typeof s.venue === "string" ? s.venue : "unknown",
        hops: num(s.hops) ?? 0,
        ...(typeof s.chain === "string" && s.chain ? { chain: s.chain } : {}),
        ...(num(s.relay_bps) !== undefined ? { relayBps: num(s.relay_bps) } : {}),
        ...(typeof s.in_tx === "string" && s.in_tx ? { inTx: s.in_tx } : {}),
        tradeUsd: num(s.trade_usd) ?? 0,
        priced: s.priced === true,
        ...(typeof s.flag === "string" && s.flag ? { flag: s.flag } : {}),
        ...(typeof s.ref_src === "string" && s.ref_src ? { refSrc: s.ref_src } : {}),
        ...(num(s.ref_age_s) !== undefined ? { refAgeS: num(s.ref_age_s) } : {}),
        ...(typeof s.x_mint === "string" && s.x_mint ? { xMint: s.x_mint } : {}),
        scanned: s.scanned === true,
        ...(sw && typeof sw.attacker === "string"
          ? {
              sandwich: {
                attacker: sw.attacker,
                frontSig: typeof sw.front_sig === "string" ? sw.front_sig : "",
                backSig: typeof sw.back_sig === "string" ? sw.back_sig : "",
                profitBps: num(sw.profit_bps) ?? 0,
              },
            }
          : {}),
        ...(num(s.loss_bps) !== undefined ? { lossBps: num(s.loss_bps) } : {}),
        ...(num(s.pool_bps) !== undefined ? { poolBps: num(s.pool_bps) } : {}),
        terminalBps: num(s.terminal_bps) ?? 0,
        networkBps: num(s.network_bps) ?? 0,
        ...(num(s.other_bps) !== undefined ? { otherBps: num(s.other_bps) } : {}),
        ...(num(s.rent_q) !== undefined && num(s.quote_usd) !== undefined ? { rentUsd: (num(s.rent_q) as number) * (num(s.quote_usd) as number) } : {}),
        ...valueSides(s),
      });
    }
  }
  return {
    generatedAt: typeof raw.generated_at === "string" ? raw.generated_at : "",
    windowHours: num(raw.window_hours) ?? 24,
    methodVersion: num(raw.method_version) ?? 0,
    minPriced: num(raw.min_priced) ?? 50,
    minRank: num(raw.min_rank) ?? 100,
    solUsd: num(raw.sol_usd) ?? 0,
    method: typeof raw.method === "string" ? raw.method : "",
    // One entry per product: the pooled `chain: all` entries when the
    // harness publishes them (per-chain entries stay in the JSON for the
    // audit), every entry otherwise (older snapshots).
    terminals: terminals.some((t) => t.chain === "all") ? terminals.filter((t) => t.chain === "all") : terminals,
    recent,
  };
}

/** Fetches the fills JSON (5 min revalidate). Null when unavailable. */
export async function getTerminalFills(): Promise<TerminalFills | null> {
  // The rows come straight from the harness JSON on the shared store, not
  // from the bench blob, so the deployment gate has to be applied here:
  // on production while bench 268 is dev-only, every section built on
  // these rows (hub, product pages, audit table) stays hidden.
  if (isDevOnlyBench("terminal-fill-quality")) return null;
  const url = process.env.TERMINAL_FILLS_URL || DEFAULT_URL;
  try {
    const res = await fetch(url, { next: { revalidate: 300 }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return parse(await res.json());
  } catch {
    return null;
  }
}

/** Ranked terminals cheapest first, then published-but-not-ranked by median, then the rest by sample size. */
export function rankTerminals(f: TerminalFills): TerminalFillStats[] {
  const tier = (t: TerminalFillStats) => (t.ranked && t.loss ? 0 : t.healthy && t.loss ? 1 : 2);
  return [...f.terminals].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta === 2) return b.priced - a.priced;
    return a.loss!.median - b.loss!.median;
  });
}

export function fmtBps(v: number | undefined): string {
  if (v === undefined) return "—";
  const sign = v < 0 ? "−" : "";
  return `${sign}${Math.abs(v) >= 100 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)} bps`;
}

export function fmtPctOfTrade(bps: number | undefined): string {
  if (bps === undefined) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}
