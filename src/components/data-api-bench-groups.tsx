"use client";

import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import {
  GROUP_META,
  fmtDataValue,
  type DataApiGroupRow,
  type DataApiBenchRow,
  type RegionLeader,
  type ChainLeader,
} from "@/lib/data-api-stats";

export function DataApiBenchGroups({ groups }: { groups: DataApiGroupRow[] }) {
  return (
    <div className="space-y-10">
      {groups.map(({ group, benches }) => {
        const meta = GROUP_META[group];
        return (
          <section key={group}>
            <div className="flex items-center gap-2.5 mb-4">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ background: meta.accent }}
              />
              <h2 className="text-[15px] font-semibold text-ink">{meta.label}</h2>
              <span className="text-[11px] text-ink-faint ml-1">{meta.description}</span>
            </div>

            <div className="rounded-xl border border-ink/10 card-soft overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-ink/8 bg-paper-soft/50">
                      <Th className="pl-5 pr-3 py-3 text-left w-[200px]">Benchmark</Th>
                      <Th className="px-3 py-3 text-right w-[60px]">Providers</Th>
                      <Th className="px-3 py-3 text-left">Leader</Th>
                      <Th className="px-3 py-3 text-left hidden sm:table-cell">Runners-up</Th>
                      <Th className="pl-3 pr-5 py-3 text-left hidden md:table-cell">Breakdown</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/5">
                    {benches.map((bench) => (
                      <BenchRow
                        key={bench.slug}
                        bench={bench}
                        accent={meta.accent}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function BenchRow({
  bench,
  accent,
}: {
  bench: DataApiBenchRow;
  accent: string;
}) {
  const hasRegions = bench.regionLeaders.length > 0;
  const hasChains = bench.chainLeaders.length > 0;
  const showRegionChain = hasRegions || hasChains;

  return (
    <tr className="group hover:bg-paper-soft/40 transition-colors">
      {/* Bench title + number */}
      <td className="pl-5 pr-3 py-3.5 align-top">
        <div className="flex flex-col gap-0.5">
          <Link
            href={`/benchmarks/${bench.slug}`}
            className="font-medium text-ink hover:text-violet-600 transition-colors leading-snug"
          >
            {bench.shortTitle}
          </Link>
          <div className="flex items-center gap-1.5">
            <span
              className="label-mono text-[10px] text-ink-faint"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              #{bench.number}
            </span>
            <span className="text-[10px] text-ink-faint">{bench.metric}</span>
          </div>
        </div>
      </td>

      {/* Provider count */}
      <td className="px-3 py-3.5 align-top text-right">
        <span
          className="label-mono text-ink-faint text-[12px]"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {bench.providerCount > 0 ? bench.providerCount : "..."}
        </span>
      </td>

      {/* Leader */}
      <td className="px-3 py-3.5 align-top min-w-[160px]">
        {bench.leader ? (
          <Link
            href={`/products/${bench.leader.slug}`}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <ProviderLogo
              slug={bench.leader.slug}
              name={bench.leader.name}
              size={18}
            />
            <div className="flex flex-col">
              <span className="font-medium text-ink leading-tight">
                {bench.leader.name}
              </span>
              <span
                className="label-mono text-[11px] font-semibold"
                style={{ color: accent, fontFamily: "var(--font-mono, monospace)" }}
              >
                {fmtDataValue(bench.leader.p50, bench.unit)}
              </span>
            </div>
          </Link>
        ) : (
          <span className="text-ink-faint">warming up</span>
        )}
      </td>

      {/* Runners-up */}
      <td className="px-3 py-3.5 align-top hidden sm:table-cell min-w-[180px]">
        <div className="flex flex-col gap-1">
          {bench.runners.length > 0 ? (
            bench.runners.map((r, i) => (
              <Link
                key={r.slug}
                href={`/products/${r.slug}`}
                className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
              >
                <span className="text-[10px] text-ink-faint w-3 text-right flex-shrink-0">
                  {i + 2}
                </span>
                <ProviderLogo slug={r.slug} name={r.name} size={14} />
                <span className="text-ink-soft text-[12px] leading-tight truncate">
                  {r.name}
                </span>
                <span
                  className="label-mono text-[10.5px] text-ink-faint ml-auto pl-1"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                >
                  {fmtDataValue(r.p50, bench.unit)}
                </span>
              </Link>
            ))
          ) : (
            <span className="text-ink-faint text-[12px]">...</span>
          )}
        </div>
      </td>

      {/* Region / chain breakdown */}
      <td className="pl-3 pr-5 py-3.5 align-top hidden lg:table-cell">
        {showRegionChain ? (
          <div className="flex flex-col gap-2">
            {hasRegions && (
              <div className="flex flex-col gap-1">
                <span className="label-mono text-[8px] text-ink-faint uppercase tracking-wider" style={{ fontFamily: "var(--font-mono, monospace)" }}>Region</span>
                <RegionStrip leaders={bench.regionLeaders} unit={bench.unit} />
              </div>
            )}
            {hasChains && (
              <div className="flex flex-col gap-1">
                <span className="label-mono text-[8px] text-ink-faint uppercase tracking-wider" style={{ fontFamily: "var(--font-mono, monospace)" }}>Chain</span>
                <ChainStrip leaders={bench.chainLeaders} unit={bench.unit} />
              </div>
            )}
          </div>
        ) : (
          <span className="text-ink-faint text-[11px]">global</span>
        )}
      </td>
    </tr>
  );
}

function RegionStrip({
  leaders,
  unit,
}: {
  leaders: RegionLeader[];
  unit: DataApiBenchRow["unit"];
}) {
  const ORDER = ["us-east", "eu-west", "sgp"];
  const sorted = [...leaders].sort(
    (a, b) => ORDER.indexOf(a.region) - ORDER.indexOf(b.region),
  );

  return (
    <div className="flex flex-wrap gap-1.5">
      {sorted.map((l) => (
        <Link
          key={l.region}
          href={`/products/${l.providerSlug}`}
          className="flex items-center gap-1 rounded-md border border-ink/8 bg-paper-soft/60 px-2 py-1 hover:border-ink/20 hover:bg-paper-soft transition-colors"
          title={`${l.label}: ${l.providerName} — ${fmtDataValue(l.p50, unit)}`}
        >
          <span
            className="label-mono text-[9px] text-ink-faint uppercase tracking-wide"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {l.region === "us-east" ? "US" : l.region === "eu-west" ? "EU" : "SGP"}
          </span>
          <ProviderLogo slug={l.providerSlug} name={l.providerName} size={12} />
          <span className="text-[10.5px] text-ink-soft font-medium">
            {l.providerName.split(" ")[0]}
          </span>
          <span
            className="label-mono text-[10px] text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {fmtDataValue(l.p50, unit)}
          </span>
        </Link>
      ))}
    </div>
  );
}

function ChainStrip({
  leaders,
  unit,
}: {
  leaders: ChainLeader[];
  unit: DataApiBenchRow["unit"];
}) {
  const uniqueWinners = new Set(leaders.map((l) => l.providerSlug)).size;
  const isSpecialist = uniqueWinners === leaders.length && leaders.length > 3;

  if (isSpecialist) {
    // Each chain has its own specialist — compact icon-only chips
    const MAX = 5;
    const visible = leaders.slice(0, MAX);
    const overflow = leaders.length - MAX;
    return (
      <div className="flex flex-wrap gap-1 items-center">
        {visible.map((l) => (
          <Link
            key={l.chain}
            href={`/products/${l.providerSlug}`}
            className="flex items-center gap-0.5 rounded border border-ink/8 bg-paper-soft/60 px-1.5 py-0.5 hover:border-ink/20 hover:bg-paper-soft transition-colors"
            title={`${l.label}: ${l.providerName} — ${fmtDataValue(l.p50, unit)}`}
          >
            <span
              className="label-mono text-[8px] text-ink-faint uppercase tracking-wide"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              {l.label}
            </span>
            <ProviderLogo slug={l.providerSlug} name={l.providerName} size={10} />
          </Link>
        ))}
        {overflow > 0 && (
          <span className="text-[9px] text-ink-faint">+{overflow}</span>
        )}
      </div>
    );
  }

  // Some provider dominates multiple chains — full pills capped at 3
  const MAX = 3;
  const visible = leaders.slice(0, MAX);
  const overflow = leaders.length - MAX;

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {visible.map((l) => (
        <Link
          key={l.chain}
          href={`/products/${l.providerSlug}`}
          className="flex items-center gap-1 rounded-md border border-ink/8 bg-paper-soft/60 px-2 py-1 hover:border-ink/20 hover:bg-paper-soft transition-colors"
          title={`${l.label}: ${l.providerName} — ${fmtDataValue(l.p50, unit)}`}
        >
          <span
            className="label-mono text-[9px] text-ink-faint uppercase tracking-wide"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {l.label}
          </span>
          <ProviderLogo slug={l.providerSlug} name={l.providerName} size={12} />
          <span className="text-[10.5px] text-ink-soft font-medium">
            {l.providerName.split(" ")[0]}
          </span>
          <span
            className="label-mono text-[10px] text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {fmtDataValue(l.p50, unit)}
          </span>
        </Link>
      ))}
      {overflow > 0 && (
        <span className="text-[10px] text-ink-faint">+{overflow}</span>
      )}
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`label-mono text-[10px] text-ink-faint font-medium ${className}`}
      style={{ fontFamily: "var(--font-mono, monospace)" }}
    >
      {children}
    </th>
  );
}
