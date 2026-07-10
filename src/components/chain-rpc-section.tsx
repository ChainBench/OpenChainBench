import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  fetchRpcHub,
  getRpcChainRow,
  RPC_REGION_KEYS,
  type RpcRegionKey,
} from "@/lib/rpc-hub-stats";

/**
 * Compact RPC summary panel for /chains/<slug>: the chain centric cut of
 * the rpc-hub cohort snapshot (the provider centric cut lives in
 * RpcProviderChainsSection on product pages). Shows the 24h p50 leader,
 * the best provider per probe region, and links out to the full
 * <chain>-rpc bench page for the complete leaderboard.
 *
 * Server component, snapshot only (fetchRpcHub reads the worker written
 * cohort blob via unstable_cache; zero Prometheus traffic). Returns null
 * when the chain has no rpc-hub row, so the page can render it
 * unconditionally, though the chain page gates the pill upfront via
 * getRpcChainRow (same cached read, no extra roundtrip).
 */

const REGION_LABELS: Record<RpcRegionKey, string> = {
  "us-east": "US East",
  "eu-west": "EU West",
  sgp: "Singapore",
};

function fmtMs(v: number): string {
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtUtc(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export async function ChainRpcSection({ chainSlug }: { chainSlug: string }) {
  const [snapshot, row] = await Promise.all([
    fetchRpcHub(),
    getRpcChainRow(chainSlug),
  ]);
  if (!snapshot || !row || !row.best) return null;

  const asOf = snapshot.generatedAt ? fmtUtc(snapshot.generatedAt) : null;

  return (
    <section className="mt-6">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
        Fastest public RPC on {row.name}
      </h2>
      <p className="mt-2 text-sm text-ink-soft leading-snug max-w-2xl">
        The fastest public RPC endpoint on {row.name} right now is{" "}
        <span className="font-medium text-ink">{row.best.providerName}</span>{" "}
        at{" "}
        <span className="font-medium text-ink tabular-nums">
          {fmtMs(row.best.p50Ms)}
        </span>{" "}
        p50 over the last 24 hours, counting successful calls only, across{" "}
        {row.providerCount} live provider
        {row.providerCount === 1 ? "" : "s"} measured from 3 probe regions.
      </p>
      <dl className="mt-4 grid grid-cols-1 sm:grid-cols-3 border-y border-rule divide-y sm:divide-y-0 sm:divide-x divide-rule">
        {RPC_REGION_KEYS.map((region) => {
          const best = row.regions[region];
          return (
            <div key={region} className="py-3 sm:px-4 sm:first:pl-0">
              <dt className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-muted">
                {REGION_LABELS[region]}
              </dt>
              <dd className="mt-1 text-[12.5px]">
                {best ? (
                  <>
                    <span className="font-medium text-ink">
                      {best.providerName}
                    </span>{" "}
                    <span className="text-ink-soft tabular-nums">
                      {fmtMs(best.p50Ms)}
                    </span>
                  </>
                ) : (
                  <span className="text-ink-faint">no data</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Link
          href={`/benchmarks/${row.slug}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:underline underline-offset-2"
        >
          Full {row.name} RPC benchmark
          <ArrowUpRight size={14} strokeWidth={2} />
        </Link>
        {asOf && (
          <span className="text-[10.5px] text-ink-faint">Data as of {asOf}</span>
        )}
      </div>
    </section>
  );
}
