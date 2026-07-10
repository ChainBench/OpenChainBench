import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import {
  fetchRpcHub,
  getRpcChainRow,
  RPC_REGION_KEYS,
  type RpcRegionKey,
  type RpcRegionBest,
} from "@/lib/rpc-hub-stats";

/**
 * RPC summary panel for /chains/<slug>: the chain centric cut of the
 * rpc-hub cohort snapshot (the provider centric cut lives in
 * RpcProviderChainsSection on product pages). A leader card plus one
 * card per probe region, in the same card language as the Live KPIs
 * strip above it, then a link out to the full <chain>-rpc bench.
 *
 * Server component, snapshot only (fetchRpcHub reads the worker written
 * cohort blob via unstable_cache; zero Prometheus traffic). Returns null
 * when the chain has no rpc-hub row; the page gates the pill upfront via
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
      <p
        className="label-mono text-[10px] text-ink-faint mb-3"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        Fastest public RPC on {row.name}
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <LeaderCard best={row.best} providerCount={row.providerCount} />
        {RPC_REGION_KEYS.map((region) => (
          <RegionCard
            key={region}
            label={REGION_LABELS[region]}
            best={row.regions[region] ?? null}
          />
        ))}
      </div>

      {/* Quotable one liner kept as plain server rendered text: this is
          the sentence answer engines lift, cards alone do not quote. */}
      <p className="mt-3 text-[12.5px] text-ink-soft leading-snug max-w-2xl">
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

      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Link
          href={`/benchmarks/${row.slug}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:underline underline-offset-2"
        >
          Full {row.name} RPC benchmark
          <ArrowUpRight size={14} strokeWidth={2} />
        </Link>
        {asOf && (
          <span className="text-[10.5px] text-ink-faint">
            Data as of {asOf}
          </span>
        )}
      </div>
    </section>
  );
}

function LeaderCard({
  best,
  providerCount,
}: {
  best: RpcRegionBest;
  providerCount: number;
}) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
      title="Lowest p50 latency across all probe regions over the last 24 hours, successful calls only."
      style={{ minHeight: 118 }}
    >
      <p
        className="label-mono text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        Fastest · 24h p50
      </p>
      <Link
        href={`/products/${best.provider}`}
        className="mt-2 flex items-center gap-2 min-w-0 group"
      >
        <ProviderLogo slug={best.provider} name={best.providerName} size={20} />
        <span className="font-medium text-ink text-sm truncate group-hover:underline underline-offset-2">
          {best.providerName}
        </span>
      </Link>
      <p className="mt-1 text-2xl font-semibold text-ink tabular-nums leading-none">
        {fmtMs(best.p50Ms)}
      </p>
      <p className="mt-auto pt-2 text-[10.5px] text-ink-faint">
        {providerCount} live provider{providerCount === 1 ? "" : "s"} measured
      </p>
    </div>
  );
}

function RegionCard({
  label,
  best,
}: {
  label: string;
  best: RpcRegionBest | null;
}) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
      title={`Fastest provider probed from ${label}, p50 over the last 24 hours.`}
      style={{ minHeight: 118 }}
    >
      <p
        className="label-mono text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {label}
      </p>
      {best ? (
        <>
          <Link
            href={`/products/${best.provider}`}
            className="mt-2 flex items-center gap-2 min-w-0 group"
          >
            <ProviderLogo
              slug={best.provider}
              name={best.providerName}
              size={20}
            />
            <span className="font-medium text-ink text-sm truncate group-hover:underline underline-offset-2">
              {best.providerName}
            </span>
          </Link>
          <p className="mt-1 text-xl font-semibold text-ink-soft tabular-nums leading-none">
            {fmtMs(best.p50Ms)}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-ink-faint italic">no data</p>
      )}
    </div>
  );
}
