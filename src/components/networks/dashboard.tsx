"use client";

import { useCallback, useState } from "react";
import { ChainFilter } from "./chain-filter";
import { KpiStrip } from "./kpi-strip";
import { NetworkPerformance } from "./network-performance";
import { ProtocolDominance } from "./protocol-dominance";
import { StatusBar } from "./status-bar";
import { StreamedVolumeCard } from "./streamed-volume-card";
import { useLiveStream } from "@/lib/live/use-live-stream";

/**
 * Top-level client wrapper for /networks. Subscribes to the live relay
 * once via `useLiveStream` and threads the resulting state through the
 * page's sub-components. The WS lifecycle, validation, and bucket
 * append/evict logic live in the hook — this file is purely layout.
 */
export function NetworksDashboard() {
  const live = useLiveStream();
  const [feedHidden, setFeedHidden] = useState(false);

  const setHidden = useCallback(
    (next: Set<string>) => {
      // Drive the hook's hiddenChains by emitting toggles for each diff.
      // Cheaper than rewriting the hook to expose a setter — the set is
      // tiny (<= 5 chains) so the loop is irrelevant.
      const cur = live.hiddenChains;
      for (const key of cur) if (!next.has(key)) live.toggleChain(key);
      for (const key of next) if (!cur.has(key)) live.toggleChain(key);
    },
    [live],
  );

  return (
    <div className="space-y-8">
      <ChainFilter hiddenChains={live.hiddenChains} onSetHidden={setHidden} />

      <StatusBar connected={live.connected} lastSnapshotAt={live.lastStatsAt} />

      <KpiStrip
        stats={live.stats}
        streamedCount={live.streamedCount}
        streamedUsd={live.streamedUsd}
        recent10sCount={live.recent10sCount}
        feedHidden={feedHidden}
        onToggleFeed={() => setFeedHidden((v) => !v)}
      />

      <StreamedVolumeCard
        series={live.series[live.range]}
        range={live.range}
        onRangeChange={live.setRange}
        pops={live.pops}
        recent={live.recent}
        serverOffsetMs={live.serverOffsetMs}
        hiddenChains={live.hiddenChains}
        onToggleChain={live.toggleChain}
        feedHidden={feedHidden}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <NetworkPerformance stats={live.stats} />
        <ProtocolDominance recent={live.recent} />
      </div>
    </div>
  );
}
