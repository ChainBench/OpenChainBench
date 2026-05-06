import type { Metadata } from "next";
import Link from "next/link";
import { getBenchmarksByCategory } from "@/data/benchmarks";
import { MiniChart } from "@/components/mini-chart";
import { fmtValue, unitSuffix } from "@/lib/format";
import { leader } from "@/lib/ranking";
import { CATEGORY_COLOR } from "@/lib/category-colors";

export const metadata: Metadata = {
  title: "Benchmarks",
  description: "Every published benchmark, grouped by category.",
};

export const revalidate = 60;

const CATEGORY_BLURB: Record<string, string> = {
  Aggregators: "Token-data aggregators. metadata, prices, charts.",
  Data: "Onchain data providers. block-level latency, network coverage.",
  Bridges: "Cross-chain bridges. quote latency and effective cost.",
  Wallets: "Wallet APIs. portfolio, balances, history.",
  RPCs: "RPC endpoints. uptime, response time, reorg behaviour.",
};

const CATEGORY_ORDER = ["Data", "Aggregators", "Bridges", "Wallets", "RPCs"] as const;

export default async function BenchmarksIndex() {
  const byCategory = await getBenchmarksByCategory();
  const sortedGroups = byCategory.sort(([a], [b]) => {
    const ai = CATEGORY_ORDER.indexOf(a as typeof CATEGORY_ORDER[number]);
    const bi = CATEGORY_ORDER.indexOf(b as typeof CATEGORY_ORDER[number]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const total = sortedGroups.reduce((s, [, list]) => s + list.length, 0);

  return (
    <div className="px-4 pt-12 pb-12 sm:pt-16 sm:pb-16">
      <div className="mx-auto max-w-6xl">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">Index</h1>
        <p className="mt-3 max-w-2xl text-base text-ink-muted leading-snug">
          Every published benchmark, grouped by category. Click into a row for
          the full report. chart, ledger, methodology and the harness that
          produces the numbers.
        </p>

        {total === 0 ? (
          <p className="mt-16 text-center text-ink-muted">
            No benchmarks yet.{" "}
            <Link className="lnk" href="/contribute">
              Submit the first one
            </Link>
            .
          </p>
        ) : (
          <div className="mt-12 space-y-14">
            {sortedGroups.map(([category, list]) => {
              const catColor = CATEGORY_COLOR[category];
              return (
                <section key={category}>
                  <header
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b-2 pb-2"
                    style={{ borderColor: catColor ?? "var(--color-ink)" }}
                  >
                    <h2
                      className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em]"
                      style={{ color: catColor ?? "var(--color-ink)" }}
                    >
                      {category}
                    </h2>
                    <p className="text-xs text-ink-muted">
                      {CATEGORY_BLURB[category]}
                    </p>
                    <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                      {list.length} {list.length === 1 ? "bench" : "benches"}
                    </span>
                  </header>

                  <ol className="divide-y divide-rule">
                    {list.map((b) => {
                      const lead = leader(b);
                      const isDraft = b.status === "draft";
                      return (
                        <li key={b.slug}>
                          <Link
                            href={`/benchmarks/${b.slug}`}
                            style={{ ["--cat-color" as string]: catColor ?? "var(--color-ink)" }}
                            className="group relative grid grid-cols-[2.5rem_1fr] sm:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_6rem_5rem] items-center gap-4 sm:gap-6 py-5 hover:bg-paper-soft/60 transition-colors before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-[var(--cat-color)] before:opacity-0 before:transition-opacity hover:before:opacity-100"
                          >
                            <span
                              className="font-mono text-[12px] font-medium tabular pl-1"
                              style={{ color: catColor ?? "var(--color-ink-soft)" }}
                            >
                              № {b.number}
                            </span>

                            <div className="min-w-0">
                              {isDraft && (
                                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                                  draft
                                </span>
                              )}
                              <h3 className="display text-base sm:text-lg font-semibold text-ink leading-tight truncate">
                                {b.title}
                              </h3>
                              <p className="mt-0.5 text-xs text-ink-muted truncate">
                                {b.subtitle}
                              </p>
                            </div>

                            <div className="hidden sm:block min-w-0">
                              {!isDraft && (
                                <MiniChart
                                  benchmark={b}
                                  height={32}
                                  legend
                                  className="opacity-90"
                                />
                              )}
                            </div>

                            <div className="hidden sm:flex justify-end items-baseline">
                              {lead && !isDraft ? (
                                <span className="font-mono tabular text-base sm:text-lg text-ink leading-none">
                                  {fmtValue(lead.ms.p50, b.unit)}
                                  <span className="text-ink-faint text-sm">
                                    {unitSuffix(b.unit)}
                                  </span>
                                </span>
                              ) : (
                                <span className="text-xs text-ink-faint">—</span>
                              )}
                            </div>

                            <div className="hidden sm:flex justify-end items-baseline font-mono text-[11px] tabular text-ink-faint">
                              {b.results.length} prov.
                            </div>
                          </Link>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
