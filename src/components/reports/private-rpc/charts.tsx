// Static charts for the October 2026 private RPC report. Plain SVG drawn
// on the server: no chart library, and they render the same with JS off.
import {
  REPORT,
  PROVIDERS,
  PROVIDER,
  REGIONS,
  CHAIN_NAME,
  Figure,
  Legend,
  logScale,
  costAt,
  chainsServed,
  httpWins,
  fmtMs,
  fmtUsd,
  fmtCount,
  INK,
  INK_SOFT,
  INK_MUTED,
  INK_FAINT,
  RULE,
} from "./shared";

const SOURCE_HTTP =
  "Source: OpenChainBench rpc-keyed-latency probes, 7 days to 28 Oct 2026 13:00 UTC. BlockMachine since 24 Oct.";

/* ------------------------------------------------------------------ */
/* Speed against price                                                 */
/* ------------------------------------------------------------------ */

const SCATTER_LABEL: Record<string, { dx: number; dy: number; anchor: "start" | "middle" | "end" }> = {
  quicknode: { dx: 0, dy: -16, anchor: "middle" },
  chainstack: { dx: -12, dy: 0, anchor: "end" },
  getblock: { dx: -12, dy: 20, anchor: "end" },
  alchemy: { dx: 12, dy: 0, anchor: "start" },
  dwellir: { dx: -12, dy: 0, anchor: "end" },
  blockmachine: { dx: 12, dy: 0, anchor: "start" },
};

export function SpeedCostChart() {
  const W = 700;
  const H = 400;
  const m = { l: 74, r: 24, t: 24, b: 48 };
  const x = logScale(80, 2500, m.l, W - m.r);
  // Lower latency is better, so it sits at the top.
  const y = logScale(3, 1000, m.t, H - m.b);
  const pts = PROVIDERS.map((p) => {
    const s = REPORT.httpSummary.find((h) => h.provider === p.slug)!;
    return { ...p, cost: costAt(REPORT.cost.dapp[p.slug], 100_000_000)!, p50: s.all.p50, p99: s.all.p99 };
  });
  const xt = [100, 200, 500, 1000, 2000];
  const yt = [3, 10, 30, 100, 300, 1000];
  return (
    <Figure
      title="Speed against price"
      subtitle="Median HTTP latency across every chain and region a provider serves (dot = p50, bar up to p99), against the monthly bill for 100M dapp requests on Ethereum. Faster is higher, cheaper is further left."
      source={`${SOURCE_HTTP} Prices: rpc-cost bench 282, catalogue of 22 Oct 2026.`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px] h-auto" role="img" aria-label="Scatter of median latency against monthly cost per provider">
        {xt.map((v) => (
          <g key={`x${v}`}>
            <line x1={x(v)} x2={x(v)} y1={m.t} y2={H - m.b} stroke={RULE} strokeDasharray="2 4" />
            <text x={x(v)} y={H - m.b + 18} fontSize={11} textAnchor="middle" style={{ fill: INK_FAINT }}>
              {fmtUsd(v)}
            </text>
          </g>
        ))}
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={RULE} strokeDasharray="2 4" />
            <text x={m.l - 8} y={y(v) + 4} fontSize={11} textAnchor="end" style={{ fill: INK_FAINT }}>
              {v >= 1000 ? "1 s" : `${v} ms`}
            </text>
          </g>
        ))}
        <text x={(m.l + W - m.r) / 2} y={H - 8} fontSize={11} textAnchor="middle" style={{ fill: INK_MUTED }}>
          Monthly bill, 100M dapp requests (log)
        </text>
        <text transform={`translate(12 ${(m.t + H - m.b) / 2}) rotate(-90)`} fontSize={11} textAnchor="middle" style={{ fill: INK_MUTED }}>
          Median latency, ms (log)
        </text>
        {pts.map((p) => {
          const L = SCATTER_LABEL[p.slug];
          return (
            <g key={p.slug}>
              <line x1={x(p.cost)} x2={x(p.cost)} y1={y(p.p50)} y2={y(p.p99)} stroke={p.color} strokeWidth={3} opacity={0.35} strokeLinecap="round" />
              <circle cx={x(p.cost)} cy={y(p.p50)} r={7} fill={p.color} stroke="var(--color-surface)" strokeWidth={2} />
              <text x={x(p.cost) + L.dx} y={y(p.p50) + L.dy + (L.dy < 0 ? -14 : 0) + 4} fontSize={12.5} fontWeight={600} textAnchor={L.anchor} style={{ fill: INK }}>
                {p.name}
              </text>
              <text x={x(p.cost) + L.dx} y={y(p.p50) + L.dy + (L.dy < 0 ? 0 : 14) + 4} fontSize={11} textAnchor={L.anchor} style={{ fill: INK_MUTED }}>
                {fmtMs(p.p50)} ms · {fmtUsd(p.cost)}
              </text>
            </g>
          );
        })}
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ */
/* Region spread                                                       */
/* ------------------------------------------------------------------ */

const REGION_COLOR: Record<string, string> = {
  "us-east": "#0EA5E9",
  "eu-west": "#65A30D",
  sgp: "#F43F5E",
};

export function RegionSpreadChart() {
  const W = 700;
  const rowH = 46;
  const m = { l: 110, r: 20, t: 14, b: 40 };
  const H = m.t + PROVIDERS.length * rowH + m.b;
  const x = logScale(1, 1000, m.l, W - m.r);
  const xt = [1, 3, 10, 30, 100, 300, 1000];
  return (
    <Figure
      title="Where each provider is fast"
      subtitle="Median warm latency per region across the chains served: dot = p50, line out to p99. One line per probe region."
      source={SOURCE_HTTP}
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-2 pb-3">
        {REGIONS.map((r) => (
          <span key={r.slug} className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: REGION_COLOR[r.slug] }} />
            {r.name}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px] h-auto" role="img" aria-label="Latency per provider and region">
        {xt.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={m.t} y2={H - m.b} stroke={RULE} strokeDasharray="2 4" />
            <text x={x(v)} y={H - m.b + 18} fontSize={11} textAnchor="middle" style={{ fill: INK_FAINT }}>
              {v >= 1000 ? "1 s" : `${v} ms`}
            </text>
          </g>
        ))}
        {PROVIDERS.map((p, i) => {
          const s = REPORT.httpSummary.find((h) => h.provider === p.slug)!;
          const y0 = m.t + i * rowH;
          return (
            <g key={p.slug}>
              {i > 0 ? <line x1={0} x2={W - m.r} y1={y0} y2={y0} stroke={RULE} /> : null}
              <circle cx={10} cy={y0 + rowH / 2} r={4} fill={p.color} />
              <text x={20} y={y0 + rowH / 2 + 4} fontSize={12.5} fontWeight={600} style={{ fill: INK }}>
                {p.name}
              </text>
              {REGIONS.map((r, j) => {
                const st = s[r.slug];
                const yy = y0 + 11 + j * 12;
                return (
                  <g key={r.slug}>
                    <text x={m.l - 8} y={yy + 3.5} fontSize={9.5} textAnchor="end" style={{ fill: INK_FAINT }}>
                      {r.short}
                    </text>
                    <line x1={x(st.p50)} x2={x(st.p99)} y1={yy} y2={yy} stroke={REGION_COLOR[r.slug]} strokeWidth={2} opacity={0.45} />
                    <circle cx={x(st.p50)} cy={yy} r={4.5} fill={REGION_COLOR[r.slug]} />
                  </g>
                );
              })}
            </g>
          );
        })}
        <text x={(m.l + W - m.r) / 2} y={H - 6} fontSize={11} textAnchor="middle" style={{ fill: INK_MUTED }}>
          Warm round trip, ms (log)
        </text>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ */
/* WebSocket first-push share                                          */
/* ------------------------------------------------------------------ */

const WS_PROVIDERS = ["quicknode", "chainstack", "getblock", "dwellir"];

export function WsFirstChart() {
  const chains = ["ethereum", "base", "bnb", "polygon", "hyperliquid", "arc"];
  const W = 700;
  const rowH = 22;
  const gap = 12;
  const m = { l: 150, r: 12, t: 6, b: 6 };
  const rows: { chain: string; region: string; label: string; cells: { p: string; v: number }[] }[] = [];
  for (const c of chains)
    for (const r of REGIONS) {
      const cells = WS_PROVIDERS.map((p) => ({
        p,
        v: REPORT.ws.find((w) => w.chain === c && w.region === r.slug && w.provider === p)?.first ?? 0,
      }));
      rows.push({ chain: c, region: r.slug, label: r.name, cells });
    }
  const H = m.t + rows.length * rowH + (chains.length - 1) * gap + m.b;
  const bw = W - m.l - m.r;
  let yCursor = m.t;
  return (
    <Figure
      title="Who pushes the new block first"
      subtitle="Share of blocks each provider delivered first over eth_subscribe(newHeads), per chain and probe region. Ten minutes in every hour, 7 days."
      source="Source: OpenChainBench WebSocket race, rpc-keyed-latency harness, 7 days to 28 Oct 2026. GetBlock has no Singapore socket on HyperEVM and Arc, nor US East on HyperEVM."
    >
      <Legend slugs={WS_PROVIDERS} />
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px] h-auto" role="img" aria-label="Share of blocks pushed first per provider">
        {rows.map((row, i) => {
          if (i > 0 && row.region === "us-east") yCursor += gap;
          const yy = yCursor;
          yCursor += rowH;
          let acc = 0;
          return (
            <g key={`${row.chain}-${row.region}`}>
              {row.region === "us-east" ? (
                <text x={0} y={yy + 15} fontSize={12.5} fontWeight={600} style={{ fill: INK }}>
                  {CHAIN_NAME[row.chain]}
                </text>
              ) : null}
              <text x={m.l - 8} y={yy + 15} fontSize={11} textAnchor="end" style={{ fill: INK_MUTED }}>
                {row.label}
              </text>
              <rect x={m.l} y={yy + 3} width={bw} height={rowH - 6} fill={RULE} opacity={0.4} />
              {row.cells.map((c) => {
                // Shares can sum to 100.7% when two providers tie on a block; scale to the track.
                const total = Math.max(100, row.cells.reduce((a, b) => a + b.v, 0));
                const w = (c.v / total) * bw;
                const x0 = m.l + acc;
                acc += w;
                if (w <= 0) return null;
                return (
                  <g key={c.p}>
                    <rect x={x0} y={yy + 3} width={w} height={rowH - 6} fill={PROVIDER[c.p].color} />
                    {c.v >= 9 ? (
                      <text x={x0 + 5} y={yy + 15} fontSize={10.5} fontWeight={700} style={{ fill: "#0b1220" }}>
                        {Math.round(c.v)}%
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ */
/* Free allowances                                                     */
/* ------------------------------------------------------------------ */

export function FreeTierChart() {
  const W = 700;
  const rowH = 30;
  const m = { l: 130, r: 70, t: 8, b: 40 };
  const rows = REPORT.free;
  const H = m.t + rows.length * rowH + m.b;
  const x = logScale(1e3, 2e7, m.l, W - m.r);
  const xt = [1e3, 1e4, 1e5, 1e6, 1e7];
  return (
    <Figure
      title="What a free plan buys"
      subtitle="Requests a month of the dapp mix on Ethereum that each renewing free allowance converts into. The thin line spans the least to the most generous workload the plan serves. Coloured rows are in our latency cohort."
      source="Source: OpenChainBench rpc-free-tier, bench 283. * allowance not verified against a published figure."
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px] h-auto" role="img" aria-label="Free plan allowance per provider">
        {xt.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={m.t} y2={H - m.b} stroke={RULE} strokeDasharray="2 4" />
            <text x={x(v)} y={H - m.b + 18} fontSize={11} textAnchor="middle" style={{ fill: INK_FAINT }}>
              {fmtCount(v)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const yy = m.t + i * rowH;
          const color = r.cohort ? PROVIDER[r.provider].color : "var(--color-ink-faint)";
          return (
            <g key={r.provider}>
              <text x={m.l - 10} y={yy + 19} fontSize={12} textAnchor="end" fontWeight={r.cohort ? 600 : 400} style={{ fill: r.cohort ? INK : INK_SOFT }}>
                {r.name}
                {r.verified ? "" : " *"}
              </text>
              <rect x={m.l} y={yy + 8} width={Math.max(x(r.value) - m.l, 2)} height={14} fill={color} opacity={r.cohort ? 1 : 0.45} />
              {r.ceiling > r.floor ? (
                <line x1={x(r.floor)} x2={x(r.ceiling)} y1={yy + 15} y2={yy + 15} stroke={INK} strokeWidth={1.2} opacity={0.6} />
              ) : null}
              <text x={Math.max(x(r.value), x(r.ceiling)) + 6} y={yy + 19} fontSize={11} style={{ fill: INK_MUTED }}>
                {fmtCount(r.value)}
              </text>
            </g>
          );
        })}
        <text x={(m.l + W - m.r) / 2} y={H - 6} fontSize={11} textAnchor="middle" style={{ fill: INK_MUTED }}>
          Dapp requests a month (log)
        </text>
      </svg>
    </Figure>
  );
}

/* ------------------------------------------------------------------ */
/* Scorecard                                                           */
/* ------------------------------------------------------------------ */

type ScoreRow = {
  label: string;
  /** One value per provider in PROVIDERS order; null = not applicable. */
  values: (number | null)[];
  fmt: (v: number) => string;
  better: "low" | "high";
  /** Free text that replaces a null cell. */
  na?: (string | null)[];
};

function rankTint(values: (number | null)[], better: "low" | "high") {
  const present = values.filter((v): v is number => v !== null);
  const sorted = [...new Set(present)].sort((a, b) => (better === "low" ? a - b : b - a));
  return values.map((v) => {
    if (v === null || sorted.length < 2) return "transparent";
    const t = sorted.indexOf(v) / (sorted.length - 1);
    // green -> amber -> red, light enough for ink text in both themes
    const hue = 150 - t * 145;
    return `hsla(${hue}, 70%, 50%, 0.22)`;
  });
}

export function Scorecard() {
  const S = (slug: string) => REPORT.httpSummary.find((h) => h.provider === slug)!;
  const wsWins = (slug: string) => {
    const cells = new Map<string, { p: string; v: number }>();
    for (const w of REPORT.ws) {
      const k = `${w.chain}|${w.region}`;
      const cur = cells.get(k);
      if (!cur || w.first > cur.v) cells.set(k, { p: w.provider, v: w.first });
    }
    return [...cells.values()].filter((c) => c.p === slug).length;
  };
  const slugs = PROVIDERS.map((p) => p.slug);
  const cost = (profile: string, r: number) => slugs.map((s) => costAt(REPORT.cost[profile]?.[s], r));
  const free = (slug: string) => REPORT.free.find((f) => f.provider === slug)?.value ?? null;
  const ms = (v: number) => `${fmtMs(v)} ms`;
  const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  const rows: ScoreRow[] = [
    { label: "HTTP warm p50", values: slugs.map((s) => S(s).all.p50), fmt: ms, better: "low" },
    { label: "HTTP warm p99", values: slugs.map((s) => S(s).all.p99), fmt: ms, better: "low" },
    { label: "HTTP cold p50", values: slugs.map((s) => S(s).all.cold50), fmt: ms, better: "low" },
    {
      label: "WebSocket wins, of 18",
      values: slugs.map((s) => (WS_PROVIDERS.includes(s) ? wsWins(s) : null)),
      fmt: (v) => String(v),
      better: "high",
      na: slugs.map((s) => (WS_PROVIDERS.includes(s) ? null : "not raced")),
    },
    {
      label: "Success rate, 7 days",
      values: slugs.map((s) => (s === "alchemy" ? null : S(s).success)),
      fmt: (v) => `${v.toFixed(2)}%`,
      better: "high",
      na: slugs.map((s) => (s === "alchemy" ? "55.2% *" : null)),
    },
    { label: "Dapp, 10M req", values: cost("dapp", 10_000_000), fmt: usd, better: "low" },
    { label: "Dapp, 1B req", values: cost("dapp", 1_000_000_000), fmt: usd, better: "low" },
    { label: "Trace, 100M req", values: cost("trace", 100_000_000), fmt: usd, better: "low" },
    {
      label: "Solana bot, 100M req",
      values: cost("solana-bot", 100_000_000),
      fmt: usd,
      better: "low",
      na: slugs.map(() => "no Solana"),
    },
    {
      label: "Free plan, dapp req/month",
      values: slugs.map((s) => free(s)),
      fmt: fmtCount,
      better: "high",
      na: slugs.map((s) => (s === "quicknode" ? "trial only" : s === "dwellir" ? "no getLogs" : null)),
    },
    {
      label: "Fastest HTTP cells, of 27",
      values: slugs.map((s) => httpWins(s).won),
      fmt: (v) => String(v),
      better: "high",
    },
    { label: "Chains served, of 9", values: slugs.map((s) => chainsServed(s)), fmt: (v) => String(v), better: "high" },
  ];
  return (
    <div className="not-prose my-10 overflow-x-auto">
      <table className="w-full min-w-[600px] text-[12px] border border-rule tabular-nums">
        <thead className="bg-[var(--color-paper-soft)] border-b border-rule">
          <tr>
            <th className="px-2.5 py-2.5 text-left label-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint font-normal" />
            {PROVIDERS.map((p) => (
              <th key={p.slug} className="px-2.5 py-2.5 text-left text-[11.5px] font-semibold text-ink whitespace-nowrap">
                <span className="inline-block h-2 w-2 rounded-full mr-1.5 align-middle" style={{ background: p.color }} />
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((row) => {
            const tints = rankTint(row.values, row.better);
            return (
              <tr key={row.label}>
                <td className="px-2.5 py-2 text-ink-muted leading-tight">{row.label}</td>
                {row.values.map((v, i) => (
                  <td key={i} className="px-2.5 py-2 text-ink whitespace-nowrap" style={{ background: tints[i] }}>
                    {v === null ? <span className="text-ink-faint">{row.na?.[i] ?? "n/a"}</span> : row.fmt(v)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 label-mono text-[10px] tracking-[0.08em] text-ink-faint">
        Green is best in the row, red worst. Latency: medians over every chain and region served, 7 days. Costs: list prices, Ethereum unless stated. * Alchemy&rsquo;s Free key on seven chains capped on 24 Oct; its enterprise-key chains answered 100%.
      </p>
    </div>
  );
}
