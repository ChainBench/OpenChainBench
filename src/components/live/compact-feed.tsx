"use client";

import { memo } from "react";
import { LiveDot } from "@/components/live-dot";
import { ProviderLogo } from "@/components/provider-logo";
import { chainMeta } from "@/lib/live/chains";
import {
  BIG_USD,
  LAG_AMBER_MS,
  LAG_GREEN_MS,
  WHALE_USD,
} from "@/lib/live/config";
import { fmtLag, fmtMoney } from "@/lib/live/format";
import type { SwapEvent } from "@/lib/live/types";

export function CompactFeed({
  recent,
  hiddenChains,
}: {
  recent: SwapEvent[];
  hiddenChains: Set<string>;
}) {
  const filtered = recent.filter((s) => {
    const meta = chainMeta(s.chain);
    return meta ? !hiddenChains.has(meta.key) : true;
  });
  return (
    // h matches the chart column (legend ~32 + svg 280 + pb-4 16 ≈ 328)
    <div className="flex flex-col h-[328px]">
      <div className="px-4 py-3 border-b border-rule flex items-center gap-2 shrink-0">
        <span className="label-mono text-ink-muted">Live feed</span>
        <LiveDot />
        <span className="ml-auto label-mono text-ink-faint">last {filtered.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <table className="w-full font-mono text-[10.5px] tabular">
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td className="text-center text-ink-faint py-8">
                  {recent.length === 0 ? "Listening…" : "All chains hidden"}
                </td>
              </tr>
            )}
            {filtered.map((s) => (
              <CompactRow key={s.hash + s.pool} s={s} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const CompactRow = memo(function CompactRow({ s }: { s: SwapEvent }) {
  const lag = Math.max(0, s.receivedMs - s.onChainMs);
  const pair = s.pair || (s.pool ? s.pool.slice(0, 8) + "…" : "-");
  const meta = chainMeta(s.chain);
  const isBuy = s.side === "buy";
  const sideColor = isBuy ? "text-good" : "text-bad";
  const sideArrow = isBuy ? "▲" : "▼";
  const isWhale = s.usd >= WHALE_USD;
  const isBig = s.usd >= BIG_USD;
  const usdClass = isWhale
    ? "font-semibold text-warn"
    : isBig
      ? "font-semibold text-ink"
      : "text-ink";
  const lagClass =
    lag < LAG_GREEN_MS ? "text-good" : lag < LAG_AMBER_MS ? "text-warn" : "text-bad";

  return (
    <tr className="border-b border-rule/40">
      <td className="pl-4 pr-1 py-1.5 align-middle">
        {meta ? (
          <ProviderLogo slug={meta.slug} name={meta.display} size={14} />
        ) : (
          <span className="inline-block h-3.5 w-3.5 rounded-full bg-paper-soft" />
        )}
      </td>
      <td className="px-1 py-1.5 text-ink whitespace-nowrap truncate max-w-[110px]">
        {pair}
      </td>
      <td className={`px-1 py-1.5 text-center w-4 ${sideColor}`}>{sideArrow}</td>
      <td className={`px-1 py-1.5 text-right whitespace-nowrap ${usdClass}`}>
        {fmtMoney(s.usd)}
      </td>
      <td className={`pl-1 pr-4 py-1.5 text-right whitespace-nowrap ${lagClass}`}>
        {fmtLag(lag)}
      </td>
    </tr>
  );
});
