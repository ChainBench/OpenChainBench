"use client";

// The two report charts with a selector: latency per region (heat map) and
// the monthly bill per workload (cost curves). Both read the same snapshot
// as the static charts.
import { useState } from "react";
import {
  REPORT,
  PROVIDERS,
  PROVIDER,
  REGIONS,
  CHAINS,
  Figure,
  Legend,
  logScale,
  costAt,
  heatColor,
  fmtMs,
  fmtUsd,
  fmtCount,
  INK,
  INK_MUTED,
  INK_FAINT,
  RULE,
  type Region,
} from "./shared";

function Tabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap border border-rule">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`px-3 py-1.5 label-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
            o.value === value ? "bg-ink text-paper" : "text-ink-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Latency heat map                                                    */
/* ------------------------------------------------------------------ */

type Metric = "p50" | "p99" | "cold50";
const METRICS: { value: Metric; label: string }[] = [
  { value: "p50", label: "Warm p50" },
  { value: "p99", label: "Warm p99" },
  { value: "cold50", label: "Cold p50" },
];

export function LatencyHeatmap() {
  const [region, setRegion] = useState<Region>("us-east");
  const [metric, setMetric] = useState<Metric>("p50");
  const W = 700;
  const m = { l: 96, t: 30 };
  const cw = (W - m.l) / PROVIDERS.length;
  const ch = 34;
  const H = m.t + CHAINS.length * ch + 4;
  const cell = (chain: string, p: string) =>
    REPORT.http.find((h) => h.chain === chain && h.region === region && h.provider === p);
  return (
    <Figure
      title="Every chain, every provider"
      subtitle="Round-trip latency in ms for eth_getBlockByNumber (getSlot on Solana), 7-day percentile per cell. The outlined cell is the fastest on that chain. Blank: the provider does not serve that chain from that region."
      source="Source: OpenChainBench rpc-keyed-latency probes every 120 s, 7 days to 28 Oct 2026 13:00 UTC. BlockMachine since 24 Oct; Alchemy on 7 chains until its Free key capped on 24 Oct."
    >
      <div className="flex flex-wrap items-center gap-2 px-2 pb-3">
        <Tabs options={REGIONS.map((r) => ({ value: r.slug, label: r.name }))} value={region} onChange={setRegion} />
        <Tabs options={METRICS} value={metric} onChange={setMetric} />
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px] h-auto" role="img" aria-label={`Latency heat map, ${region}`}>
          {PROVIDERS.map((p, j) => (
            <text key={p.slug} x={m.l + j * cw + cw / 2} y={18} fontSize={12} fontWeight={600} textAnchor="middle" style={{ fill: INK }}>
              {p.name}
            </text>
          ))}
          {CHAINS.map((c, i) => {
            const yy = m.t + i * ch;
            const vals = PROVIDERS.map((p) => cell(c.slug, p.slug)?.[metric]);
            const present = vals.filter((v): v is number => v !== undefined);
            const best = present.length ? Math.min(...present) : undefined;
            return (
              <g key={c.slug}>
                <text x={m.l - 10} y={yy + ch / 2 + 4} fontSize={12} textAnchor="end" style={{ fill: INK_MUTED }}>
                  {c.name}
                </text>
                {PROVIDERS.map((p, j) => {
                  const v = vals[j];
                  const x0 = m.l + j * cw;
                  if (v === undefined)
                    return <rect key={p.slug} x={x0 + 2} y={yy + 2} width={cw - 4} height={ch - 4} fill={RULE} opacity={0.35} />;
                  return (
                    <g key={p.slug}>
                      <rect
                        x={x0 + 2}
                        y={yy + 2}
                        width={cw - 4}
                        height={ch - 4}
                        fill={heatColor(v)}
                        stroke={v === best ? INK : "none"}
                        strokeWidth={v === best ? 2 : 0}
                      />
                      <text x={x0 + cw / 2} y={yy + ch / 2 + 4.5} fontSize={12.5} fontWeight={v === best ? 700 : 500} textAnchor="middle" style={{ fill: "#0b1220" }}>
                        {fmtMs(v)}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex items-center gap-2 px-2 pt-3 text-[11px] text-ink-faint">
        <span>1 ms</span>
        <span
          className="h-2 w-40"
          style={{ background: `linear-gradient(90deg, ${[1, 3, 8, 25, 80, 300].map((v) => heatColor(v)).join(", ")})` }}
        />
        <span>300 ms+</span>
      </div>
    </Figure>
  );
}

/* ------------------------------------------------------------------ */
/* Cost curves                                                         */
/* ------------------------------------------------------------------ */

type Profile = "dapp" | "indexer" | "trace" | "solana-bot";
const PROFILES: { value: Profile; label: string; note: string }[] = [
  { value: "dapp", label: "Dapp", note: "Dapp frontend on Ethereum: 40% eth_call, 15% each balances, block number and receipts, 5% each gas estimates, sends and logs." },
  { value: "indexer", label: "Indexer", note: "Log indexer on Ethereum at archive depth: 50% eth_getLogs, 25% eth_getBlockByNumber, 25% eth_getBlockReceipts." },
  { value: "trace", label: "Trace", note: "Trace and debug on Ethereum at archive depth: 60% debug_traceTransaction, 20% trace_block, 20% eth_getBlockByNumber." },
  { value: "solana-bot", label: "Solana bot", note: "Solana trading bot: 40% getAccountInfo, 20% getMultipleAccounts, 15% getLatestBlockhash, 15% sendTransaction, 10% simulateTransaction. Dwellir and BlockMachine do not price Solana." },
];

export function CostCurves() {
  const [profile, setProfile] = useState<Profile>("dapp");
  const W = 700;
  const H = 380;
  const m = { l: 56, r: 130, t: 16, b: 44 };
  const x = logScale(1e6, 1e9, m.l, W - m.r);
  const y = logScale(5, 40000, H - m.b, m.t);
  const curves = REPORT.cost[profile];
  const xt = [1e6, 1e7, 1e8, 1e9];
  const yt = [10, 100, 1000, 10000];
  const marks = [1e7, 1e8, 1e9];
  const present = PROVIDERS.filter((p) => curves[p.slug]);
  // End labels sit at each line's last served value; nudge apart so they never overlap.
  const ends = present
    .map((p) => {
      const pts = curves[p.slug].filter((pt) => pt[1] !== null);
      const last = pts[pts.length - 1];
      return { slug: p.slug, x: x(last[0]), y: y(last[1] as number), v: last[1] as number, r: last[0] };
    })
    .sort((a, b) => a.y - b.y);
  const labelled = ends.filter((e) => e.r >= 1e9);
  for (let i = 1; i < labelled.length; i++)
    if (labelled[i].y - labelled[i - 1].y < 14) labelled[i].y = labelled[i - 1].y + 14;
  const note = PROFILES.find((p) => p.value === profile)!.note;
  return (
    <Figure
      title="Monthly bill by volume"
      subtitle="Cheapest plan of each provider that can serve the volume, list prices. Each step is a plan change. A line ending in a cross stops at the volume where the provider's throughput cap is reached."
      source="Source: OpenChainBench rpc-cost, bench 282, catalogue of 22 Oct 2026. The calculator on the bench page prices any volume from 100k to 5B."
    >
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
        <Tabs options={PROFILES.map(({ value, label }) => ({ value, label }))} value={profile} onChange={setProfile} />
      </div>
      <p className="px-2 pb-2 text-[12px] text-ink-muted">{note}</p>
      <Legend slugs={present.map((p) => p.slug)} />
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Monthly bill by volume, ${profile}`}>
        {xt.map((v) => (
          <g key={`x${v}`}>
            <line x1={x(v)} x2={x(v)} y1={m.t} y2={H - m.b} stroke={RULE} strokeDasharray={marks.includes(v) ? "0" : "2 4"} opacity={marks.includes(v) ? 0.9 : 1} />
            <text x={x(v)} y={H - m.b + 18} fontSize={11} textAnchor="middle" style={{ fill: INK_FAINT }}>
              {fmtCount(v)}
            </text>
          </g>
        ))}
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={RULE} strokeDasharray="2 4" />
            <text x={m.l - 8} y={y(v) + 4} fontSize={11} textAnchor="end" style={{ fill: INK_FAINT }}>
              {fmtUsd(v)}
            </text>
          </g>
        ))}
        <text x={(m.l + W - m.r) / 2} y={H - 6} fontSize={11} textAnchor="middle" style={{ fill: INK_MUTED }}>
          Requests a month (log)
        </text>
        {present.map((p) => {
          const segs: string[] = [];
          let cur = "";
          for (const [r, usd] of curves[p.slug]) {
            if (usd === null) {
              if (cur) segs.push(cur);
              cur = "";
              continue;
            }
            cur += `${cur ? "L" : "M"}${x(r).toFixed(1)},${y(usd).toFixed(1)}`;
          }
          if (cur) segs.push(cur);
          return (
            <g key={p.slug}>
              {segs.map((d, i) => (
                <path key={i} d={d} fill="none" stroke={p.color} strokeWidth={2.4} strokeLinejoin="round" />
              ))}
              {marks.map((r) => {
                const v = costAt(curves[p.slug], r);
                if (v === null) return null;
                return (
                  <circle key={r} cx={x(r)} cy={y(v)} r={3.5} fill={p.color} stroke="var(--color-surface)" strokeWidth={1.5}>
                    <title>{`${PROVIDER[p.slug].name}, ${fmtCount(r)} requests: $${Math.round(v).toLocaleString("en-US")}`}</title>
                  </circle>
                );
              })}
            </g>
          );
        })}
        {ends.map((e) =>
          e.r < 1e9 ? (
            <g key={e.slug}>
              <path d={`M${e.x - 4},${y(e.v) - 4}L${e.x + 4},${y(e.v) + 4}M${e.x - 4},${y(e.v) + 4}L${e.x + 4},${y(e.v) - 4}`} stroke={PROVIDER[e.slug].color} strokeWidth={2} />
              <title>{`${PROVIDER[e.slug].name} cannot serve more than about ${fmtCount(e.r)} requests a month on this workload`}</title>
            </g>
          ) : (
            <text key={e.slug} x={W - m.r + 8} y={e.y + 4} fontSize={11.5} fontWeight={600} style={{ fill: PROVIDER[e.slug].color }}>
              {PROVIDER[e.slug].name} ${Math.round(e.v).toLocaleString("en-US")}
            </text>
          ),
        )}
      </svg>
    </Figure>
  );
}
