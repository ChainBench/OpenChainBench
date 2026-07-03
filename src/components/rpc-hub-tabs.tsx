"use client";

import { useState } from "react";
import { RpcChainsLeaderboard } from "@/components/rpc-chains-leaderboard";
import { RpcProvidersPivot } from "@/components/rpc-providers-pivot";
import type { RpcHubSnapshot } from "@/lib/rpc-hub-stats";

/**
 * Tab wrapper for the /rpc hub. Mirrors PmHubTabs: two pills that swap
 * the leaderboard underneath without a second network round trip. The
 * snapshot is fetched server side and passed in as one prop; the client
 * owns only the tab state.
 *
 * Default tab is "By chain" — the page's headline matrix. "By provider"
 * is the pivot: which gateway covers which chains, at what rank.
 */

type Tab = "chains" | "providers";

export function RpcHubTabs({ snapshot }: { snapshot: RpcHubSnapshot }) {
  const [tab, setTab] = useState<Tab>("chains");

  return (
    <>
      <div
        className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40 mb-4"
        role="tablist"
        aria-label="RPC benchmarks view"
      >
        <TabButton
          active={tab === "chains"}
          onClick={() => setTab("chains")}
          count={snapshot.chains.length}
        >
          By chain
        </TabButton>
        <TabButton
          active={tab === "providers"}
          onClick={() => setTab("providers")}
          count={snapshot.providersPivot.length}
        >
          By provider
        </TabButton>
      </div>

      {tab === "chains" && <RpcChainsLeaderboard rows={snapshot.chains} />}
      {tab === "providers" && (
        <RpcProvidersPivot
          rows={snapshot.providersPivot}
          chains={snapshot.chains.map((c) => ({
            chain: c.chain,
            name: c.name,
            slug: c.slug,
          }))}
        />
      )}
    </>
  );
}

function TabButton({
  children,
  active,
  count,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors flex items-center gap-2 ${
        active ? "bg-paper text-ink shadow-sm" : "text-ink-soft hover:text-ink"
      }`}
    >
      {children}
      <span
        className="text-[10.5px] text-ink-faint"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {count}
      </span>
    </button>
  );
}
