import Link from "next/link";
import {
  fetchDataApiSnapshot,
  fmtDataValue,
  GROUP_META,
  GROUP_ORDER,
} from "@/lib/data-api-stats";

/**
 * "Data API" view on /products/<slug>, behind the pill bar. One
 * provider's row of the /data-api pivot, opened up: for every group
 * (price feeds, token metadata, portfolio, DEX coverage, NFT data) the
 * benches the provider is measured on, its rank and p50, and where it
 * leads by region or by chain.
 *
 * Server component, snapshot-only (fetchDataApiSnapshot reads the
 * worker-written blob). Returns null when the provider is not in the
 * data-API cohort.
 */
export async function DataApiProviderSection({
  slug,
  name,
}: {
  slug: string;
  name: string;
}) {
  const snapshot = await fetchDataApiSnapshot();
  const row = snapshot?.providers.find((p) => p.slug === slug);
  if (!snapshot || !row || row.cells.length === 0) return null;

  const groups = GROUP_ORDER.filter((g) => row.cells.some((c) => c.group === g));
  const wins = row.cells.filter((c) => c.rank === 1).length;

  return (
    <section id="data-api" className="scroll-mt-24 py-10 border-t border-ink/8 first:border-0">
      <header className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-2xl sm:text-3xl font-semibold display tracking-tight">{name}</h2>
          <span
            className="label-mono text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md border border-ink/15 text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Data API
          </span>
          <span className="text-sm text-ink-muted">
            {row.cells.length} {row.cells.length === 1 ? "benchmark" : "benchmarks"} in {groups.length}{" "}
            {groups.length === 1 ? "group" : "groups"}
            {wins > 0 ? `, ${wins} #1` : ""}
          </span>
        </div>
        <Link href="/data-api" className="text-sm text-ink-faint hover:text-ink underline underline-offset-2">
          All data APIs
        </Link>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {groups.map((g) => {
          const meta = GROUP_META[g];
          const cells = row.cells.filter((c) => c.group === g).sort((a, b) => a.rank - b.rank);
          return (
            <div key={g} className="card-soft rounded-lg p-4 border border-ink/15">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.accent }} aria-hidden />
                <p
                  className="text-[10px] uppercase tracking-wide text-ink-faint"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                >
                  {meta.label}
                </p>
              </div>
              <ul className="divide-y divide-rule">
                {cells.map((c) => (
                  <li key={c.benchSlug} className="py-2.5 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/benchmarks/${c.benchSlug}`}
                        className="font-medium text-ink hover:underline underline-offset-2 text-sm"
                      >
                        {c.benchShortTitle}
                      </Link>
                      {c.cellWins && c.cellWins.length > 0 && (
                        <p className="mt-1 text-[11px] text-ink-faint leading-snug">
                          #1 on{" "}
                          {c.cellWins
                            .map((w) => `${w.chains.map((x) => x.label).join(", ")} from ${w.regionLabel}`)
                            .join("; ")}
                        </p>
                      )}
                      {!c.cellWins?.length && c.regions && c.regions.length > 0 && (
                        <p className="mt-1 text-[11px] text-ink-faint leading-snug">
                          {c.regions.map((r) => `${r.label} #${r.rank}`).join(" · ")}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="tabular-nums text-sm text-ink">{fmtDataValue(c.p50, c.unit)}</p>
                      <p
                        className="text-[10px] uppercase tracking-[0.14em]"
                        style={{ color: c.rank === 1 ? "var(--color-good)" : "var(--color-ink-faint)" }}
                      >
                        rank #{c.rank}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-ink-faint">
        Same figures as the {name} row of the{" "}
        <Link href="/data-api" className="underline hover:no-underline">
          /data-api
        </Link>{" "}
        pivot, as of {new Date(snapshot.generatedAt).toUTCString().replace("GMT", "UTC")}.
      </p>
    </section>
  );
}
