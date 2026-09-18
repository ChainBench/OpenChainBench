"use client";

import { useMemo, useState } from "react";
import type { FillSample } from "@/lib/terminal-fills";

/**
 * Explorable table of the sampled swaps behind bench 268, for QA: every
 * row is one real transaction with a Solscan link, its side, venue,
 * reference source, size and cost split. Filters by terminal, side,
 * venue and reference; sort by any numeric column. Client component over
 * the JSON the section already loads (last few hundred samples).
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
  const th = (key: SortKey, label: string, title?: string) => (
    <th
      className={`py-2 px-2 text-right text-[10px] uppercase tracking-[0.14em] font-medium whitespace-nowrap cursor-pointer select-none ${sort.key === key ? "text-ink" : "text-ink-faint"}`}
      title={title}
      onClick={() => setSort((p) => ({ key, dir: p.key === key ? ((p.dir * -1) as 1 | -1) : -1 }))}
    >
      {label}
      {sort.key === key ? (sort.dir < 0 ? " ↓" : " ↑") : ""}
    </th>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
        <Sel id="tfs-terminal" value={terminal} onChange={setTerminal} label="Terminal" options={terminals.map((t) => [t.slug, t.name])} />
        <Sel id="tfs-side" value={side} onChange={setSide} label="Side" options={[["buy", "Buy"], ["sell", "Sell"]]} />
        <Sel id="tfs-venue" value={venue} onChange={setVenue} label="Venue" options={venues.map((v) => [v, v])} />
        <Sel id="tfs-ref" value={ref} onChange={setRef} label="Reference" options={[["reserves", "reserves (exact mid)"], ["pool", "previous trade"], ["none", "unpriced"]]} />
        <span className="text-ink-faint ml-auto">
          {rows.length} swaps · click a hash to open it on Solscan
        </span>
      </div>
      <div className="overflow-x-auto border-y border-rule">
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-rule text-left">
              {th("time", "When")}
              <th className="py-2 px-2 text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-left">Terminal</th>
              <th className="py-2 px-2 text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-left">Tx</th>
              <th className="py-2 px-2 text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-left">Side · venue</th>
              {th("trade", "Trade", "buy: quote spent; sell: tokens × reference")}
              {th("loss", "Loss", "1 − value received / value given, bps")}
              {th("terminal", "Fee", "terminal fee, bps")}
              {th("network", "Net", "tx fee + tips, bps")}
              <th className="py-2 px-2 text-right text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium" title="pump.fun / creator / referral fees, bps (single-pool routes)">Other</th>
              {th("pool", "Pool", "loss − explicit costs: LP fee + impact (+ hops), bps")}
              <th className="py-2 px-2 text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-left" title="reserves: exact pre-trade mid; pool: previous trade on the pool, age in seconds">Ref</th>
              <th className="py-2 px-2 text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium text-left">Sandwich</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.slice(0, limit).map((s) => (
              <tr key={s.sig} className="hover:bg-paper-soft/40">
                <td className="py-1.5 px-2 whitespace-nowrap text-ink-soft">{fmtTime(s.time)}</td>
                <td className="py-1.5 px-2 whitespace-nowrap font-medium">{nameOf(s.terminal)}</td>
                <td className="py-1.5 px-2 whitespace-nowrap">
                  <a href={`https://solscan.io/tx/${s.sig}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:no-underline font-mono text-[11px]">
                    {s.sig.slice(0, 8)}…
                  </a>
                </td>
                <td className="py-1.5 px-2 whitespace-nowrap text-ink-soft">
                  <span className={s.side === "buy" ? "text-[var(--color-good)]" : ""}>{s.side}</span> · {s.venue}
                  {s.xMint ? <span className="text-ink-faint" title={`route through ${s.xMint}`}> · via X</span> : null}
                </td>
                <td className="py-1.5 px-2 text-right whitespace-nowrap">${s.tradeUsd >= 1000 ? (s.tradeUsd / 1000).toFixed(1) + "K" : s.tradeUsd.toFixed(0)}</td>
                <td className="py-1.5 px-2 text-right whitespace-nowrap font-medium">{s.lossBps === undefined ? <span className="text-ink-faint">—</span> : Math.round(s.lossBps)}</td>
                <td className="py-1.5 px-2 text-right text-ink-soft">{Math.round(s.terminalBps)}</td>
                <td className="py-1.5 px-2 text-right text-ink-soft">{Math.round(s.networkBps)}</td>
                <td className="py-1.5 px-2 text-right text-ink-soft">{s.otherBps === undefined ? "—" : Math.round(s.otherBps)}</td>
                <td className="py-1.5 px-2 text-right text-ink-soft">{s.poolBps === undefined ? "—" : Math.round(s.poolBps)}</td>
                <td className="py-1.5 px-2 whitespace-nowrap text-ink-faint">
                  {s.refSrc ?? "—"}
                  {s.refSrc === "pool" && s.refAgeS !== undefined ? ` ${s.refAgeS}s` : ""}
                </td>
                <td className="py-1.5 px-2 whitespace-nowrap text-ink-faint">{s.sandwiched ? <span className="text-[var(--color-bad,#e5484d)]">yes</span> : s.scanned ? "no" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <button type="button" onClick={() => setLimit((l) => l + 100)} className="mt-2 text-[11px] underline underline-offset-2 hover:no-underline text-ink-soft">
          Show {Math.min(100, rows.length - limit)} more
        </button>
      )}
    </div>
  );
}

type SortKey = "time" | "trade" | "loss" | "terminal" | "network" | "pool";

function Sel({ id, value, onChange, label, options }: { id: string; value: string; onChange: (v: string) => void; label: string; options: string[][] }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-ink-soft">
      <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="rounded border border-rule bg-paper px-1.5 py-0.5 text-[11px] text-ink">
        <option value="">all</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function fmtTime(t: number): string {
  if (!t) return "—";
  const d = new Date(t * 1000);
  return d.toISOString().slice(5, 16).replace("T", " ") + "Z";
}
