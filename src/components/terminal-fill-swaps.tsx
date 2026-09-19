"use client";

import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  ExternalLink,
  History,
  Layers,
  RotateCcw,
  Route,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import type { FillSample } from "@/lib/terminal-fills";

/**
 * Audit table of the sampled swaps behind bench 268: every row is one
 * real transaction with its Solscan link, side and route, size, loss
 * with its cost split drawn as a stacked bar, reference source and
 * sandwich screen. Filters by terminal, side, venue and reference; sort
 * by any numeric column; a summary strip of the filtered set. Client
 * component over the JSON the page already loads (last 400 samples).
 */
export function TerminalFillSwaps({ swaps, terminals, focus }: { swaps: FillSample[]; terminals: { slug: string; name: string }[]; focus?: string }) {
  const [terminal, setTerminal] = useState(focus ?? "");
  const [side, setSide] = useState("");
  const [venue, setVenue] = useState("");
  const [ref, setRef] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "time", dir: -1 });
  const [limit, setLimit] = useState(50);

  const venues = useMemo(() => [...new Set(swaps.map((s) => s.venue))].sort(), [swaps]);
  const rows = useMemo(() => {
    const f = swaps.filter(
      (s) => (!terminal || s.terminal === terminal) && (!side || s.side === side) && (!venue || s.venue === venue) && (!ref || (s.refSrc ?? "none") === ref),
    );
    const v = (s: FillSample): number => {
      switch (sort.key) {
        case "time":
          return s.time;
        case "trade":
          return s.tradeUsd;
        case "loss":
          return s.lossBps ?? -Infinity;
        case "terminal":
          return s.terminalBps;
        case "network":
          return s.networkBps;
        case "pool":
          return s.poolBps ?? -Infinity;
      }
    };
    return f.sort((a, b) => (v(a) - v(b)) * sort.dir);
  }, [swaps, terminal, side, venue, ref, sort]);
  const nameOf = (slug: string) => terminals.find((t) => t.slug === slug)?.name ?? slug;
  const filtered = terminal !== (focus ?? "") || side || venue || ref;
  const reset = () => {
    setTerminal(focus ?? "");
    setSide("");
    setVenue("");
    setRef("");
  };
  const stats = useMemo(() => {
    const losses = rows
      .filter((s) => s.priced && s.lossBps !== undefined)
      .map((s) => s.lossBps as number)
      .sort((a, b) => a - b);
    return {
      n: rows.length,
      priced: losses.length,
      flagged: rows.filter((s) => s.flag).length,
      sandwiched: rows.filter((s) => s.sandwich).length,
      scanned: rows.filter((s) => s.scanned).length,
      median: losses.length ? losses[Math.floor(losses.length / 2)] : undefined,
    };
  }, [rows]);

  const th = (k: SortKey | undefined, label: string, title?: string, align: "left" | "right" = "right") => {
    const active = k !== undefined && sort.key === k;
    return (
      <th
        scope="col"
        className={`sticky top-0 z-10 bg-paper py-2.5 px-3 text-[10px] uppercase tracking-[0.14em] font-medium whitespace-nowrap border-b border-rule ${align === "right" ? "text-right" : "text-left"} ${k ? "cursor-pointer select-none hover:text-ink" : ""} ${active ? "text-ink" : "text-ink-faint"}`}
        title={title}
        onClick={k ? () => setSort((p) => ({ key: k, dir: p.key === k ? ((p.dir * -1) as 1 | -1) : -1 })) : undefined}
        aria-sort={active ? (sort.dir < 0 ? "descending" : "ascending") : undefined}
      >
        <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
          {label}
          {k ? active ? sort.dir < 0 ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3 opacity-30" /> : null}
        </span>
      </th>
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 mb-3">
        <Field label="Terminal">
          <select id="tfs-terminal" value={terminal} onChange={(e) => setTerminal(e.target.value)} className={selectCls}>
            <option value="">All terminals</option>
            {terminals.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Side">
          <Seg
            value={side}
            onChange={setSide}
            options={[
              ["", "All"],
              ["buy", "Buy"],
              ["sell", "Sell"],
            ]}
          />
        </Field>
        <Field label="Venue">
          <select id="tfs-venue" value={venue} onChange={(e) => setVenue(e.target.value)} className={selectCls}>
            <option value="">All venues</option>
            {venues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference">
          <Seg
            value={ref}
            onChange={setRef}
            options={[
              ["", "All"],
              ["reserves", "Exact mid"],
              ["pool", "Previous trade"],
              ["none", "Unpriced"],
            ]}
          />
        </Field>
        {filtered ? (
          <button type="button" onClick={reset} className="inline-flex items-center gap-1 self-center text-[11px] text-ink-soft hover:text-ink underline underline-offset-2">
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint tabular-nums self-center">
          <Stat value={stats.n} label="swaps" />
          <Stat value={stats.priced} label="priced" />
          <Stat value={stats.median !== undefined ? `${Math.round(stats.median)} bps` : "—"} label="median loss" />
          <Stat value={`${stats.sandwiched} / ${stats.scanned}`} label="sandwiched / screened" />
          {stats.flagged > 0 ? <Stat value={stats.flagged} label="flagged" /> : null}
        </div>
      </div>

      <div className="overflow-auto max-h-[70vh] rounded-lg border border-rule">
        <table className="w-full min-w-[1120px] text-[12px] tabular-nums">
          <thead>
            <tr>
              {th("time", "When", "UTC block time", "left")}
              {th(undefined, "Terminal", undefined, "left")}
              {th(undefined, "Transaction", "click to open on Solscan", "left")}
              {th(undefined, "Side · route", "final pool's venue; hops = pool instructions of the route before it; via X = final pool quoted in a third asset", "left")}
              {th("trade", "Trade", "buy: quote spent, tx fee included; sell: tokens × reference")}
              {th(undefined, "In $", "USD value the user gave: buy = quote spent (tx fee inside); sell = tokens at the pool's pre-trade reference, plus the gas paid apart on an EVM chain")}
              {th(undefined, "Out $", "USD value the user received: buy = tokens at the pool's pre-trade reference; sell = quote received")}
              {th("loss", "Loss", "1 − value received / value given, basis points of the trade; ! = out of bounds, excluded from the statistics")}
              {th(undefined, "Where it goes", "terminal fee · network (tx fee + tips) · other (pump.fun, creator, referral) · pool (LP fee + impact, hops); shared 0 to 1,000 bps scale", "left")}
              {th("terminal", "Fee", "terminal fee, bps")}
              {th("network", "Net", "tx fee + inclusion tips, bps")}
              {th(undefined, "Other", "pump.fun / creator / referral fees, bps (single-pool swaps without hops)")}
              {th("pool", "Pool", "loss − explicit costs: LP fee + impact (+ hops), bps")}
              {th(undefined, "Reference", "exact mid: the pool's reserves before the swap; previous trade: the trade before ours on the same pool, age in seconds", "left")}
              {th(undefined, "Sandwich", "neighbours on the pool screened; a hit links to the front-run, hover for the attacker", "left")}
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.slice(0, limit).map((s) => (
              <tr key={s.sig} className="hover:bg-paper-soft/50 transition-colors">
                <td className="py-2 px-3 whitespace-nowrap text-ink-soft">{fmtTime(s.time)}</td>
                <td className="py-2 px-3 whitespace-nowrap">
                  <span className="inline-flex items-center gap-2 font-medium text-ink">
                    <ProviderLogo slug={s.terminal} name={nameOf(s.terminal)} size={16} />
                    {nameOf(s.terminal)}
                  </span>
                </td>
                <td className="py-2 px-3 whitespace-nowrap">
                  <a
                    href={`${txExplorer(s)}${s.sig}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-soft hover:text-ink"
                    title={s.sig}
                  >
                    {s.sig.slice(0, 6)}…{s.sig.slice(-4)}
                    <ExternalLink className="h-3 w-3 opacity-60" />
                  </a>
                </td>
                <td className="py-2 px-3 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <SideChip side={s.side} />
                    <span className="font-mono text-[11px] text-ink-soft">{s.venue}</span>
                    {s.hops > 0 ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-faint" title={`${s.hops} hop instruction${s.hops > 1 ? "s" : ""} before the final pool`}>
                        <Route className="h-3 w-3" />
                        {s.hops}
                      </span>
                    ) : null}
                    {s.xMint ? (
                      <span className="text-[10px] uppercase tracking-[0.1em] text-ink-faint" title={`final pool quoted in ${s.xMint}, priced through the route's own hop`}>
                        via X
                      </span>
                    ) : null}
                    {s.chain && s.inTx ? (
                      <a
                        href={`${(s.terminal.endsWith("-" + s.chain) ? EXPLORERS.solana : EXPLORERS[s.chain]) ?? EXPLORERS.solana}${s.inTx}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] uppercase tracking-[0.1em] text-ink-faint underline underline-offset-2 hover:text-ink"
                        title={s.terminal.endsWith("-" + s.chain) ? `paid in USDC or SOL on Solana, settled on ${CHAIN_NAMES[s.chain] ?? s.chain}: open the deposit` : `paid on ${CHAIN_NAMES[s.chain] ?? s.chain}: open the origin deposit`}
                      >
                        {s.terminal.endsWith("-" + s.chain) ? `on ${CHAIN_NAMES[s.chain] ?? s.chain}` : `from ${CHAIN_NAMES[s.chain] ?? s.chain}`}
                      </a>
                    ) : s.chain ? (
                      <span className="text-[10px] uppercase tracking-[0.1em] text-ink-faint">from {CHAIN_NAMES[s.chain] ?? s.chain}</span>
                    ) : null}
                  </span>
                </td>
                <td className="py-2 px-3 text-right whitespace-nowrap">{fmtUsd(s.tradeUsd)}</td>
                <td className="py-2 px-3 text-right whitespace-nowrap text-ink-soft">{s.valueInUsd !== undefined ? fmtUsd(s.valueInUsd) : "—"}</td>
                <td className="py-2 px-3 text-right whitespace-nowrap text-ink-soft">{s.valueOutUsd !== undefined ? fmtUsd(s.valueOutUsd) : "—"}</td>
                <td className="py-2 px-3 text-right whitespace-nowrap">
                  <LossCell s={s} />
                </td>
                <td className="py-2 px-3">
                  <SplitBar s={s} />
                </td>
                <td className="py-2 px-3 text-right text-ink-soft">{Math.round(s.terminalBps)}</td>
                <td className="py-2 px-3 text-right text-ink-soft">{Math.round(s.networkBps)}</td>
                <td className="py-2 px-3 text-right text-ink-soft">{s.otherBps === undefined ? <span className="text-ink-faint">—</span> : Math.round(s.otherBps)}</td>
                <td className="py-2 px-3 text-right text-ink-soft">{s.poolBps === undefined ? <span className="text-ink-faint">—</span> : Math.round(s.poolBps)}</td>
                <td className="py-2 px-3 whitespace-nowrap">
                  <RefCell s={s} />
                </td>
                <td className="py-2 px-3 whitespace-nowrap">
                  <SandwichCell s={s} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={13} className="py-8 text-center text-ink-faint">
                  No swap matches these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-ink-faint">
        <span>
          Showing {Math.min(limit, rows.length)} of {rows.length}
        </span>
        {rows.length > limit ? (
          <button
            type="button"
            onClick={() => setLimit((l) => l + 100)}
            className="text-[10px] uppercase tracking-[0.16em] px-3 py-1.5 border border-ink/20 rounded-md hover:border-ink/40 hover:bg-ink/5 transition-colors text-ink-soft"
          >
            Show {Math.min(100, rows.length - limit)} more
          </button>
        ) : null}
      </div>
    </div>
  );
}

type SortKey = "time" | "trade" | "loss" | "terminal" | "network" | "pool";

const COLORS = { terminal: "#FF6B35", network: "#FFC857", relay: "#2DD4BF", other: "#8B5CF6", pool: "#5B89FF" } as const;
const LABELS = { terminal: "Terminal fee", network: "Network", relay: "Relay", other: "Other fees", pool: "Pool" } as const;
const CHAIN_NAMES: Record<string, string> = { bnb: "BNB", robinhood: "Robinhood", base: "Base", ethereum: "Ethereum", arc: "Arc", hyperevm: "HyperEVM", solana: "Solana" };
const EXPLORERS: Record<string, string> = { bnb: "https://bscscan.com/tx/", robinhood: "https://explorer.mainnet.chain.robinhood.com/tx/", base: "https://basescan.org/tx/", ethereum: "https://etherscan.io/tx/", arc: "https://explorer.arc.io/tx/", hyperevm: "https://hyperevmscan.io/tx/", solana: "https://solscan.io/tx/" };
/** The settlement's explorer: Solana rows settle on Solana, the per-chain rows on that chain. */
function txExplorer(s: FillSample): string {
  if (s.chain && s.chain !== "solana" && s.terminal.endsWith("-" + s.chain)) {
    // A Relay sale settles on Solana (sig is the Solana signature); everything else on that chain is native or a Relay buy
    if (s.side === "sell" && (s.terminal.startsWith("fomo-") || s.terminal.startsWith("basedbot-"))) return "https://solscan.io/tx/";
    return EXPLORERS[s.chain];
  }
  return "https://solscan.io/tx/";
}

const selectCls = "h-7 rounded-md border border-rule bg-paper px-2 text-[11px] text-ink hover:border-ink/40 focus:outline-none focus:border-ink/60";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-[0.16em] text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

/** Segmented control. */
function Seg({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <span className="inline-flex h-7 rounded-md border border-rule bg-paper p-0.5">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={`px-2 rounded text-[11px] transition-colors ${value === v ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
        >
          {l}
        </button>
      ))}
    </span>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <span>
      <span className="text-ink font-medium">{typeof value === "number" ? value.toLocaleString("en-US") : value}</span> {label}
    </span>
  );
}

function SideChip({ side }: { side: "buy" | "sell" }) {
  const buy = side === "buy";
  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] ${buy ? "bg-good/10 text-good" : "bg-bad/10 text-bad"}`}>
      {buy ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {side}
    </span>
  );
}

/** Loss figure with a small gauge (0 to 1,000 bps), coloured by size. */
function LossCell({ s }: { s: FillSample }) {
  if (s.lossBps === undefined) return <span className="text-ink-faint">—</span>;
  const v = s.lossBps;
  const w = Math.max(0, Math.min(1, v / 1000)) * 44;
  const color = v < 200 ? "var(--color-good)" : v < 600 ? "var(--color-warn)" : "var(--color-bad)";
  return (
    <span className={`inline-flex items-center gap-2 ${s.flag ? "text-ink-faint" : "text-ink font-medium"}`} title={s.flag ? `excluded: ${s.flag}` : `${v.toFixed(1)} bps of the trade`}>
      <svg width="44" height="6" viewBox="0 0 44 6" aria-hidden="true" className="shrink-0">
        <rect x="0" y="0" width="44" height="6" rx="3" fill="currentColor" opacity="0.12" />
        {w > 0 ? <rect x="0" y="0" width={w} height="6" rx="3" fill={color} opacity={s.flag ? 0.4 : 1} /> : null}
      </svg>
      <span className="w-12 text-right">
        {v < 0 ? "−" : ""}
        {Math.round(Math.abs(v))}
        {s.flag ? <span className="ml-0.5 text-bad">!</span> : null}
      </span>
    </span>
  );
}

/** Stacked bar of the swap's cost split, on a shared 0 to 1,000 bps scale. */
function SplitBar({ s }: { s: FillSample }) {
  const parts = (
    [
      ["terminal", s.terminalBps],
      ["network", s.networkBps],
      ["relay", s.relayBps ?? 0],
      ["other", s.otherBps ?? 0],
      ["pool", s.poolBps ?? 0],
    ] as const
  )
    .map(([c, v]) => ({ c, v: Math.max(0, v) }))
    .filter((p) => p.v > 0);
  if (parts.length === 0) return <span className="text-ink-faint">—</span>;
  const scale = 96 / 1000;
  let x = 0;
  const title = parts.map((p) => `${LABELS[p.c]}: ${Math.round(p.v)} bps`).join("\n");
  return (
    <svg width="96" height="8" viewBox="0 0 96 8" aria-hidden="true" className="block">
      <title>{title}</title>
      <rect x="0" y="1" width="96" height="6" rx="3" fill="currentColor" opacity="0.08" />
      {parts.map((p) => {
        const w = Math.max(0, Math.min(96 - x, p.v * scale));
        const el = <rect key={p.c} x={x} y="1" width={w} height="6" fill={COLORS[p.c]} />;
        x += w;
        return el;
      })}
    </svg>
  );
}

function RefCell({ s }: { s: FillSample }) {
  if (s.refSrc === "reserves")
    return (
      <span className="inline-flex items-center gap-1.5 text-ink-soft" title="the pool's exact mid before the swap, from its reserves in the transaction">
        <Layers className="h-3.5 w-3.5 text-ink-faint" /> exact mid
      </span>
    );
  if (s.refSrc === "pool")
    return (
      <span className="inline-flex items-center gap-1.5 text-ink-soft" title="effective price of the previous trade on the same pool">
        <History className="h-3.5 w-3.5 text-ink-faint" /> previous trade
        {s.refAgeS !== undefined ? <span className="text-ink-faint">{s.refAgeS}s</span> : null}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-faint" title="no readable pool state: cost split kept, no loss figure">
      <CircleDashed className="h-3.5 w-3.5" /> unpriced
    </span>
  );
}

function SandwichCell({ s }: { s: FillSample }) {
  if (s.sandwich)
    return (
      <a
        href={`https://solscan.io/tx/${s.sandwich.frontSig}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-bad hover:underline underline-offset-2"
        title={`attacker ${s.sandwich.attacker}\nfront-run ${s.sandwich.frontSig}\nback-run ${s.sandwich.backSig}\nattacker profit ${Math.round(s.sandwich.profitBps)} bps of the trade`}
      >
        <ShieldAlert className="h-3.5 w-3.5" /> hit
      </a>
    );
  if (s.scanned)
    return (
      <span className="inline-flex items-center gap-1.5 text-ink-faint" title="neighbours on the pool read, no sandwich">
        <ShieldCheck className="h-3.5 w-3.5" /> clean
      </span>
    );
  return (
    <span className="text-ink-faint" title="neighbourhood not readable (very busy pool or too recent)">
      —
    </span>
  );
}

function fmtUsd(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toFixed(v >= 10 ? 0 : 2)}`;
}

function fmtTime(t: number): string {
  if (!t) return "—";
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
