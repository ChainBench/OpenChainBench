import Link from "next/link";
import { getProviders } from "@/lib/providers";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { fmtUnit } from "@/lib/format";

interface Props {
  providerSlug: string;
}

export async function BenchAppearancesSection({ providerSlug }: Props) {
  const profiles = await getProviders();
  const p = profiles.find(
    (pr) => pr.slug.toLowerCase() === providerSlug.toLowerCase(),
  );
  if (!p || p.appearances.length === 0) return null;

  const sorted = [...p.appearances].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.benchmark.title.localeCompare(b.benchmark.title);
  });

  return (
    <section className="mt-6">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
        Live benchmark results
      </h2>
      <ol className="mt-4 divide-y divide-rule border-y border-rule">
        {sorted.map((a) => {
          const catColor = CATEGORY_COLOR[a.benchmark.category];
          const hasData = a.rank > 0 && a.result.ms.p50 !== 0;
          const value = hasData ? fmtUnit(a.result.ms.p50, a.benchmark.unit) : null;
          const chainRanks =
            a.rankPerChain && a.benchmark.chainDimensions
              ? a.benchmark.chainDimensions
                  .filter((c) => c.value !== "all")
                  .map((c) => ({ chain: c, entry: a.rankPerChain?.[c.value] }))
                  .filter(
                    (
                      x,
                    ): x is {
                      chain: { value: string; label: string };
                      entry: { rank: number; totalRanked: number };
                    } => !!x.entry,
                  )
              : [];
          const hasChainRanks = chainRanks.length > 0;
          return (
            <li key={a.benchmark.slug}>
              <Link
                href={`/benchmarks/${a.benchmark.slug}`}
                className="group grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] items-start sm:items-center gap-x-4 gap-y-2 py-5 pl-3 pr-3 hover:bg-paper-soft/60 transition-colors"
              >
                <span
                  className="font-sans tabular text-xl sm:text-2xl font-semibold w-12 text-center"
                  style={{ color: a.rank === 1 ? "var(--color-good)" : "var(--color-ink-soft)" }}
                >
                  {hasData ? (
                    <>
                      #{a.rank}
                      <span className="block text-[9px] uppercase tracking-[0.16em] text-ink-faint mt-0.5">
                        of {a.totalRanked}
                      </span>
                    </>
                  ) : (
                    <span className="block text-[10px] uppercase tracking-[0.16em] text-ink-faint italic font-normal">
                      awaiting
                    </span>
                  )}
                </span>
                <div className="min-w-0">
                  <p className="font-sans text-[10px] uppercase tracking-[0.18em] font-medium" style={{ color: catColor ?? "var(--color-ink-faint)" }}>
                    {a.benchmark.category}
                  </p>
                  <h3 className="mt-0.5 display text-base sm:text-lg font-semibold leading-tight truncate">
                    {a.benchmark.title}
                  </h3>
                  <p className="text-xs text-ink-muted truncate">
                    {a.benchmark.metric}
                  </p>
                  {hasChainRanks && (
                    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-sans text-[10px] uppercase tracking-[0.14em] font-medium">
                      {chainRanks.map(({ chain, entry }) => (
                        <span
                          key={chain.value}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                            entry.rank === 1
                              ? "border-good/40 bg-good/10 text-good"
                              : "border-rule bg-paper-soft text-ink-muted"
                          }`}
                        >
                          #{entry.rank} on {chain.label}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
                <div className="col-start-2 sm:col-start-3 text-left sm:text-right">
                  {hasData ? (
                    <>
                      <p className="font-sans tabular text-base text-ink">{value}</p>
                      <p className="font-sans text-[9px] uppercase tracking-[0.16em] text-ink-faint mt-0.5 font-medium">
                        p50 · 24h
                      </p>
                    </>
                  ) : (
                    <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint italic font-medium">
                      data warming up
                    </p>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
