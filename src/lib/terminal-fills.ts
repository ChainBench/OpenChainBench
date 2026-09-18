/**
 * Reader for the terminal-fill-quality harness output (bench 268): what a
 * swap costs the user on each Solana trading terminal / Telegram bot,
 * from sampled user transactions read on-chain and valued at the pool's
 * arrival price (previous trade on the same pool).
 *
 * JSON written by the harness to the aggregate dir and served by Caddy at
 * kv.openchainbench.com/aggregate/terminal-fills/fills.json. The site
 * only reads it; nothing here touches Prometheus.
 */

const DEFAULT_URL = "https://kv.openchainbench.com/aggregate/terminal-fills/fills.json";

export type FillQuantiles = { median: number; mean: number; p90: number; n: number };

export type TerminalFillStats = {
  slug: string;
  name: string;
  kind: "app" | "bot";
  note?: string;
  seen: number;
  failed: number;
  /** Percent of the terminal's transactions that failed on-chain; undefined under 20 seen. */
  failRatePct?: number;
  parsed: number;
  priced: number;
  /** Loss vs arrival price, basis points of the trade; undefined without priced samples. */
  loss?: FillQuantiles;
  /** Median cost components, bps: terminal, network, other, pool (when known). */
  components: Partial<Record<"terminal" | "network" | "other" | "pool", number>>;
  tradeUsd?: FillQuantiles;
  /** Share of priced samples by reference source: reserves (exact mid), pool (previous trade), jupiter. */
  refSrcPct: Record<string, number>;
  /** Block scan: swaps whose block was read, sandwiched ones, share (from 20 scanned), attacker profit. */
  scanned: number;
  sandwiched: number;
  sandwichPct?: number;
  sandwichProfit?: FillQuantiles;
  /** Median loss by trade-size bucket: under25, 25to250, over250 (from 5 samples). */
  bySize: Partial<Record<"under25" | "25to250" | "over250", FillQuantiles>>;
  buySharePct: number;
  venueSharePct: Record<string, number>;
  quoteSharePct: Record<string, number>;
  healthy: boolean;
};

export type FillSample = {
  sig: string;
  terminal: string;
  time: number;
  side: "buy" | "sell";
  quote: string;
  venue: string;
  tradeUsd: number;
  priced: boolean;
  refSrc?: string;
  refAgeS?: number;
  lossBps?: number;
  poolBps?: number;
  terminalBps: number;
  networkBps: number;
  otherBps?: number;
};

export type TerminalFills = {
  generatedAt: string;
  windowHours: number;
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
  const mean = num(x.mean);
  const p90 = num(x.p90);
  const n = num(x.n);
  if (median === undefined || mean === undefined || p90 === undefined || n === undefined) return undefined;
  return { median, mean, p90, n };
}
function numMap(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isRecord(x)) for (const [k, v] of Object.entries(x)) if (typeof v === "number") out[k] = v;
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
      ...(typeof t.note === "string" && t.note ? { note: t.note } : {}),
      seen: num(t.seen) ?? 0,
      failed: num(t.failed) ?? 0,
      ...(num(t.fail_rate_pct) !== undefined ? { failRatePct: num(t.fail_rate_pct) } : {}),
      parsed: num(t.parsed) ?? 0,
      priced: num(t.priced) ?? 0,
      ...(quant(t.loss_bps) ? { loss: quant(t.loss_bps) } : {}),
      components: {
        ...(comps.terminal !== undefined ? { terminal: comps.terminal } : {}),
        ...(comps.network !== undefined ? { network: comps.network } : {}),
        ...(comps.other !== undefined ? { other: comps.other } : {}),
        ...(comps.pool !== undefined ? { pool: comps.pool } : {}),
      },
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
    });
  }
  const recent: FillSample[] = [];
  if (Array.isArray(raw.recent)) {
    for (const s of raw.recent) {
      if (!isRecord(s) || typeof s.sig !== "string" || typeof s.terminal !== "string") continue;
      recent.push({
        sig: s.sig,
        terminal: s.terminal,
        time: num(s.time) ?? 0,
        side: s.side === "sell" ? "sell" : "buy",
        quote: typeof s.quote === "string" ? s.quote : "SOL",
        venue: typeof s.venue === "string" ? s.venue : "unknown",
        tradeUsd: num(s.trade_usd) ?? 0,
        priced: s.priced === true,
        ...(typeof s.ref_src === "string" ? { refSrc: s.ref_src } : {}),
        ...(num(s.ref_age_s) !== undefined ? { refAgeS: num(s.ref_age_s) } : {}),
        ...(num(s.loss_bps) !== undefined ? { lossBps: num(s.loss_bps) } : {}),
        ...(num(s.pool_bps) !== undefined ? { poolBps: num(s.pool_bps) } : {}),
        terminalBps: num(s.terminal_bps) ?? 0,
        networkBps: num(s.network_bps) ?? 0,
        ...(num(s.other_bps) !== undefined ? { otherBps: num(s.other_bps) } : {}),
      });
    }
  }
  return {
    generatedAt: typeof raw.generated_at === "string" ? raw.generated_at : "",
    windowHours: num(raw.window_hours) ?? 24,
    solUsd: num(raw.sol_usd) ?? 0,
    method: typeof raw.method === "string" ? raw.method : "",
    terminals,
    recent,
  };
}

/** Fetches the fills JSON (5 min revalidate). Null when unavailable. */
export async function getTerminalFills(): Promise<TerminalFills | null> {
  const url = process.env.TERMINAL_FILLS_URL || DEFAULT_URL;
  try {
    const res = await fetch(url, { next: { revalidate: 300 }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return parse(await res.json());
  } catch {
    return null;
  }
}

/** Terminals with a published figure, cheapest first, then the rest. */
export function rankTerminals(f: TerminalFills): TerminalFillStats[] {
  const pub = f.terminals.filter((t) => t.healthy && t.loss).sort((a, b) => a.loss!.median - b.loss!.median);
  const rest = f.terminals.filter((t) => !(t.healthy && t.loss)).sort((a, b) => b.priced - a.priced);
  return [...pub, ...rest];
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
