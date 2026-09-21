"use client";

import { useState } from "react";
import { RpcChainsLeaderboard } from "@/components/rpc-chains-leaderboard";
import { RpcProvidersPivot } from "@/components/rpc-providers-pivot";
import type { RpcHubCohort, RpcHubSnapshot } from "@/lib/rpc-hub-stats";

/**
 * Tab wrapper for the /rpc hub. Mirrors PmHubTabs: two pills that swap
 * the leaderboard underneath without a second network round trip. The
 * snapshot is fetched server side and passed in as one prop; the client
 * owns only the tab state.
 *
 * Default tab is "By chain" — the page's headline matrix. "By provider"
 * is the pivot: which gateway covers which chains, at what rank.
 *
 * Endpoints selector (2026-09-21): the snapshot carries the API-key
 * cohort next to the public one. The selector swaps the whole block,
 * summary cards included, between the two; nothing on the page ranks a
 * public gateway against a keyed provider. The public view is the
 * default and the only one crawlers see; the keyed rows link to
 * `/benchmarks/<chain>-rpc#tier=keyed`, the tab that ranks them.
 */

type Tab = "chains" | "providers";
type Cohort = "public" | "keyed";

export function RpcHubTabs({
  snapshot,
  linkableSlugs,
}: {
  snapshot: RpcHubSnapshot;
  linkableSlugs?: string[];
}) {
  // One count on the screen: the chains whose page is indexable (the
  // same set the "All N chain RPC pages" nav lists), not the worker's
  // total that includes thin chains (154 vs 114 on 2026-09-21).
  const chainCount = (c: RpcHubCohort) =>
    linkableSlugs ? c.chains.filter((ch) => linkableSlugs.includes(ch.slug)).length : c.chains.length;
  const [tab, setTab] = useState<Tab>("chains");
  const [cohort, setCohort] = useState<Cohort>("public");
  const keyed = snapshot.keyed;
  const view: RpcHubCohort = cohort === "keyed" && keyed ? keyed : snapshot;
  const benchQuery = cohort === "keyed" && keyed ? "#tier=keyed" : "";
  // Keyed chain pages are indexable through their public view; the
  // sitemap gate applies to the page, not to the cohort.
  const fastest = fastestOverall(view);

  return (
    <>
      {keyed && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint shrink-0 font-medium">
            Access
          </span>
          <div
            className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40"
            role="tablist"
            aria-label="RPC access cohort"
          >
            <TabButton
              active={cohort === "public"}
              onClick={() => setCohort("public")}
              count={chainCount(snapshot)}
            >
              Public, no key
            </TabButton>
            <TabButton
              active={cohort === "keyed"}
              onClick={() => setCohort("keyed")}
              count={chainCount(keyed)}
            >
              Private, API key
            </TabButton>
          </div>
          <span className="text-[12px] text-ink-faint">
            {cohort === "keyed"
              ? "Private endpoints (API key): Alchemy, Chainstack and QuickNode, probed every 120 s. Ranked on their own, never against the public gateways."
              : "Free, no-key endpoints probed every 60 s."}
          </span>
        </div>
      )}

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <SummaryCard label="Chains benched" value={String(chainCount(view))} accent="#0ea5e9" />
        <SummaryCard label="Unique providers" value={String(view.totals.uniqueProviders)} />
        <SummaryCard
          label="Probe regions"
          value={String(view.totals.regions)}
          tip="us-east (N. Virginia), eu-west (Amsterdam), Singapore. Every provider is probed from all three."
        />
        <SummaryCard
          label={cohort === "keyed" ? "Lowest private median" : "Fastest provider overall"}
          value={fastest ? `${fastest.provider} · ${fmtMs(fastest.p50Ms)}` : "..."}
          tip={
            fastest
              ? `Best chain leader across the ${cohort === "keyed" ? "private" : "public"} matrix: ${fastest.provider} on ${fastest.chain} (24h p50, all regions).`
              : undefined
          }
        />
      </section>

      <div
        className="inline-flex rounded-lg border border-ink/15 p-1 bg-paper-soft/40 mb-4"
        role="tablist"
        aria-label="RPC benchmarks view"
      >
        <TabButton
          active={tab === "chains"}
          onClick={() => setTab("chains")}
          count={view.chains.length}
        >
          By chain
        </TabButton>
        <TabButton
          active={tab === "providers"}
          onClick={() => setTab("providers")}
          count={view.providersPivot.length}
        >
          By provider
        </TabButton>
      </div>

      {tab === "chains" && (
        <RpcChainsLeaderboard
          key={cohort}
          rows={view.chains}
          linkableSlugs={linkableSlugs}
          benchQuery={benchQuery}
        />
      )}
      {tab === "providers" && (
        <RpcProvidersPivot
          key={cohort}
          rows={view.providersPivot}
          chains={view.chains.map((c) => ({
            chain: c.chain,
            name: c.name,
            slug: c.slug,
          }))}
        />
      )}
    </>
  );
}

/** Best chain leader across the matrix: the lowest per-chain p50. */
function fastestOverall(
  view: RpcHubCohort,
): { chain: string; provider: string; p50Ms: number } | null {
  return view.chains.reduce<{ chain: string; provider: string; p50Ms: number } | null>((acc, c) => {
    if (!c.best) return acc;
    if (!acc || c.best.p50Ms < acc.p50Ms) {
      return { chain: c.name, provider: c.best.providerName, p50Ms: c.best.p50Ms };
    }
    return acc;
  }, null);
}

function SummaryCard({
  label,
  value,
  accent,
  tip,
}: {
  label: string;
  value: string;
  accent?: string;
  tip?: string;
}) {
  return (
    <div className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15" title={tip}>
      <p
        className="label-mono text-[10px] text-ink-faint mb-1 flex items-center gap-1.5"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {accent && (
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: accent }} />
        )}
        {label}
      </p>
      <p className="text-lg sm:text-2xl font-semibold tabular-nums leading-tight">{value}</p>
    </div>
  );
}

function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return "...";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
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
