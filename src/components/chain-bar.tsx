import { chainColor } from "@/lib/trading-app-history";

/**
 * Stacked bar of an app's volume per chain (last closed UTC day, bench
 * 267), chain colours shared with the cohort bar, plus the dominant
 * chain(s) as text. One glance says "all Solana" vs "Robinhood-led,
 * three chains". Server-safe.
 */
export function ChainBar({
  split,
  width = 64,
}: {
  split: { chain: string; usd: number; pct: number }[];
  width?: number;
}) {
  if (split.length === 0) return <span className="text-ink-faint">—</span>;
  const lead = split[0];
  const label =
    split.length === 1
      ? lead.chain
      : `${lead.chain} ${lead.pct.toFixed(0)}% · ${split[1].chain} ${split[1].pct >= 1 ? `${split[1].pct.toFixed(0)}%` : "<1%"}${split.length > 2 ? ` · +${split.length - 2}` : ""}`;
  return (
    <span
      className="inline-flex items-center gap-2.5"
      title={split.map((c) => `${c.chain}: ${fmtUsd(c.usd)} (${c.pct.toFixed(1)}%)`).join("\n")}
    >
      <span className="flex h-1.5 shrink-0 overflow-hidden rounded-full bg-paper-soft" style={{ width }}>
        {split.map((c, i) => (
          <span key={c.chain} style={{ width: `${c.pct}%`, background: chainColor(c.chain, i) }} />
        ))}
      </span>
      <span className="text-[11px] text-ink-soft whitespace-nowrap">{label}</span>
    </span>
  );
}

function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
