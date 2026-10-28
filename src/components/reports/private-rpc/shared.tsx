// Shared data, palette and scales for the October 2026 private RPC report.
// Every figure the charts draw comes from one snapshot file, so a chart and
// the prose beside it cannot drift apart.
import data from "@/data/reports/private-rpc-2026-10.json";

export const REPORT = data as unknown as ReportData;

export type Region = "us-east" | "eu-west" | "sgp";

export type HttpCell = {
  chain: string;
  region: Region;
  provider: string;
  p50: number;
  p99: number;
  cold50: number;
};

export type WsCell = {
  chain: string;
  region: Region;
  provider: string;
  first: number;
  seen: number;
  lag50: number;
  lag90: number;
};

type Stat = { p50: number; p99: number; cold50: number };

export type HttpSummary = {
  provider: string;
  "us-east": Stat;
  "eu-west": Stat;
  sgp: Stat;
  all: Stat;
  success: number;
  calls: number;
  errors: Record<string, number>;
};

/** [requests per month, usd or null when the plan cannot serve it, plan id] */
export type CostPoint = [number, number | null, string | null];

export type ReportData = {
  asOf: string;
  window: string;
  http: HttpCell[];
  httpSummary: HttpSummary[];
  ws: WsCell[];
  wsDisconnects: Record<string, number>;
  cost: Record<string, Record<string, CostPoint[]>>;
  free: {
    provider: string;
    name: string;
    value: number;
    floor: number;
    ceiling: number;
    cohort: boolean;
    verified: boolean;
  }[];
};

export const PROVIDERS: { slug: string; name: string; color: string }[] = [
  { slug: "quicknode", name: "QuickNode", color: "#3B82F6" },
  { slug: "chainstack", name: "Chainstack", color: "#14B8A6" },
  { slug: "getblock", name: "GetBlock", color: "#A855F7" },
  { slug: "alchemy", name: "Alchemy", color: "#EAB308" },
  { slug: "dwellir", name: "Dwellir", color: "#EC4899" },
  { slug: "blockmachine", name: "BlockMachine", color: "#F97316" },
];

export const PROVIDER = Object.fromEntries(PROVIDERS.map((p) => [p.slug, p]));

export const REGIONS: { slug: Region; name: string; short: string }[] = [
  { slug: "us-east", name: "US East", short: "US" },
  { slug: "eu-west", name: "EU West", short: "EU" },
  { slug: "sgp", name: "Singapore", short: "SG" },
];

export const CHAINS: { slug: string; name: string }[] = [
  { slug: "ethereum", name: "Ethereum" },
  { slug: "base", name: "Base" },
  { slug: "arbitrum", name: "Arbitrum" },
  { slug: "bnb", name: "BNB Chain" },
  { slug: "polygon", name: "Polygon" },
  { slug: "solana", name: "Solana" },
  { slug: "hyperliquid", name: "HyperEVM" },
  { slug: "robinhood", name: "Robinhood" },
  { slug: "arc", name: "Arc" },
];

export const CHAIN_NAME = Object.fromEntries(CHAINS.map((c) => [c.slug, c.name]));

/** Log scale from a value domain onto a pixel range. */
export function logScale(d0: number, d1: number, r0: number, r1: number) {
  const l0 = Math.log10(d0);
  const l1 = Math.log10(d1);
  return (v: number) => r0 + ((Math.log10(Math.max(v, d0)) - l0) / (l1 - l0)) * (r1 - r0);
}

/** Bill at an exact volume, interpolated inside the curve's segments. The
 *  emitter puts a point at every plan corner, so between two points the
 *  bill is affine and the interpolation is exact. */
export function costAt(points: CostPoint[] | undefined, r: number): number | null {
  if (!points) return null;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (x === r) return y;
    if (x > r) {
      if (i === 0) return null;
      const [x0, y0] = points[i - 1];
      if (y0 === null || y === null) return null;
      return y0 + ((y - y0) * (r - x0)) / (x - x0);
    }
  }
  return null;
}

const HEAT_STOPS: [number, [number, number, number]][] = [
  [1, [16, 185, 129]],
  [8, [132, 204, 22]],
  [25, [250, 204, 21]],
  [80, [249, 115, 22]],
  [300, [239, 68, 68]],
];

/** Latency to a fill: green under ~5 ms, amber around 25, red from 300. */
export function heatColor(ms: number): string {
  const v = Math.log10(Math.min(Math.max(ms, 1), 300));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [m1, c1] = HEAT_STOPS[i];
    if (v <= Math.log10(m1)) {
      const [m0, c0] = HEAT_STOPS[i - 1];
      const t = (v - Math.log10(m0)) / (Math.log10(m1) - Math.log10(m0));
      const c = c0.map((a, k) => Math.round(a + (c1[k] - a) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  const last = HEAT_STOPS[HEAT_STOPS.length - 1][1];
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`;
}

export function fmtMs(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)} s`;
  if (v >= 100) return `${Math.round(v)}`;
  return v.toFixed(1);
}

export function fmtUsd(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 1 : 2).replace(/\.?0+$/, "")}k`;
  return `$${Math.round(v)}`;
}

export function fmtCount(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(v % 1e9 ? 1 : 0)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 ? 1 : 0).replace(/\.0$/, "")}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return `${Math.round(v)}`;
}

export const INK = "var(--color-ink)";
export const INK_SOFT = "var(--color-ink-soft)";
export const INK_MUTED = "var(--color-ink-muted)";
export const INK_FAINT = "var(--color-ink-faint)";
export const RULE = "var(--color-rule-strong)";

export function Figure({
  title,
  subtitle,
  source,
  children,
}: {
  title: string;
  subtitle?: string;
  source?: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="not-prose my-10 border border-rule bg-[var(--color-surface)]">
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-rule">
        <p className="label-mono text-[10px] uppercase tracking-[0.22em] text-ink">{title}</p>
        {subtitle ? <p className="mt-1.5 text-[13px] leading-snug text-ink-muted">{subtitle}</p> : null}
      </div>
      <div className="px-2 sm:px-4 py-4">{children}</div>
      {source ? (
        <figcaption className="px-4 sm:px-5 py-2.5 border-t border-rule label-mono text-[10px] tracking-[0.08em] text-ink-faint">
          {source}
        </figcaption>
      ) : null}
    </figure>
  );
}

export function Legend({ slugs }: { slugs: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-2 pb-3">
      {slugs.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: PROVIDER[s].color }} />
          {PROVIDER[s].name}
        </span>
      ))}
    </div>
  );
}
