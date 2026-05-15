"use client";

import { useMemo } from "react";
import { LiveChart, RangePicker } from "@/components/live/chart";
import { CompactFeed } from "@/components/live/compact-feed";
import { LiveDot } from "@/components/live-dot";
import { cumulativePerChain } from "@/lib/live/buckets";
import { RANGE_LABELS } from "@/lib/live/config";
import { fmtMoney } from "@/lib/live/format";
import type { ChartPop, ChartSeries, RangeKey, SwapEvent } from "@/lib/live/types";

/**
 * Big chart card for /networks. Wraps the existing LiveChart in
 * `embed` mode so we own the card chrome, header, and the right-side
 * feed column — matches Screenshot 3 exactly while reusing the chart's
 * internal SVG drawing, hover tooltip, and pop overlay logic.
 */
export function StreamedVolumeCard({
  series,
  range,
  onRangeChange,
  pops,
  recent,
  serverOffsetMs,
  hiddenChains,
  onToggleChain,
  feedHidden,
}: {
  series: ChartSeries;
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
  pops: ChartPop[];
  recent: SwapEvent[];
  serverOffsetMs: number;
  hiddenChains: Set<string>;
  onToggleChain: (key: string) => void;
  feedHidden: boolean;
}) {
  const totalCum = useMemo(() => {
    const cum = cumulativePerChain(series.buckets);
    let sum = 0;
    for (const k in cum) {
      if (!hiddenChains.has(k)) sum += cum[k];
    }
    return sum;
  }, [series.buckets, hiddenChains]);

  return (
    <section className="card-soft rounded-xl overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-rule">
        <span className="label-mono text-ink-muted">Streamed volume</span>
        <span className="text-ink-faint">·</span>
        <RangePicker range={range} onRangeChange={onRangeChange} />
        <LiveDot />
        <span className="text-ink-faint">·</span>
        <span className="font-mono tabular text-[11px] text-ink-soft">
          {fmtMoney(totalCum)} total · {RANGE_LABELS[range].toLowerCase()}
        </span>
      </header>

      <div
        className={`grid grid-cols-1 ${
          feedHidden ? "" : "lg:grid-cols-[minmax(0,1fr)_320px]"
        }`}
      >
        <LiveChart
          variant="embed"
          series={series}
          range={range}
          onRangeChange={onRangeChange}
          pops={pops}
          recent={recent}
          serverOffsetMs={serverOffsetMs}
          hiddenChains={hiddenChains}
          onToggleChain={onToggleChain}
        />
        {!feedHidden && (
          <aside className="border-t lg:border-t-0 lg:border-l border-rule flex flex-col">
            <CompactFeed recent={recent} hiddenChains={hiddenChains} />
          </aside>
        )}
      </div>
    </section>
  );
}
