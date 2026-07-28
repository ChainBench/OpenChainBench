import Link from "next/link";
import { getBenchmark } from "@/data/benchmarks";
import { rankedCandidates } from "@/lib/citation";
import { fmtUnit } from "@/lib/format";
import { ProviderLogo } from "@/components/provider-logo";

type Props = {
  bench: string;
  chain?: string;
  region?: string;
  caption?: string;
  showSuccessRate?: boolean;
};

export async function StatTable({
  bench,
  chain,
  region,
  caption,
  showSuccessRate = true,
}: Props) {
  const b = await getBenchmark(bench, { chain, region }).catch(() => undefined);
  if (!b || b.editorialStatus !== "live") {
    return (
      <p className="my-6 text-sm text-ink-muted italic">
        Live data temporarily unavailable. See{" "}
        <Link className="lnk" href={`/benchmarks/${bench}`}>
          /benchmarks/{bench}
        </Link>
        .
      </p>
    );
  }

  const ranked = rankedCandidates(b);
  if (!ranked.length) return null;

  const hasSuccess = showSuccessRate && ranked.some((r) => r.successRate != null);

  // Leader = #1 by p50. Most reliable = best success rate (only when hasSuccess).
  // Label is "FASTEST" for latency benches (ms/s/sec), "LEADER" for count/rate/other.
  const leaderSlug = ranked[0].slug;
  const leaderLabel = ["ms", "s", "sec"].includes(b.unit ?? "") ? "FASTEST" : "LEADER";
  const reliableSlug = hasSuccess
    ? [...ranked].sort((a, c) => (c.successRate ?? 0) - (a.successRate ?? 0))[0].slug
    : null;
  // Show RELIABLE badge on the most-reliable provider regardless of whether
  // it's also the latency leader (fastestSlug === reliableSlug). When they
  // coincide, one row shows both badges, surfacing the "double winner" case
  // instead of hiding the reliability signal entirely.
  const fastestSlug = leaderSlug;

  return (
    <figure className="my-10 not-prose">
      <div className="border-t-[2px] border-ink overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-2.5 pr-3 pl-0 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium w-6">
                #
              </th>
              <th className="text-left py-2.5 pr-3 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium">
                Provider
              </th>
              <th className="text-right py-2.5 pr-3 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium">
                p50 {b.unit && <span className="normal-case">({b.unit})</span>}
              </th>
              {hasSuccess && (
                <th className="text-right py-2.5 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium">
                  Success
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => {
              const isFastest = r.slug === fastestSlug;
              const isReliable = reliableSlug !== null && r.slug === reliableSlug;
              const successPct = r.successRate ?? 100;
              const successColor =
                successPct >= 99
                  ? "text-ink"
                  : successPct >= 95
                    ? "text-ink-soft"
                    : "text-amber-600 dark:text-amber-400";

              return (
                <tr
                  key={r.slug}
                  className={`border-b border-rule transition-colors ${
                    isFastest || isReliable
                      ? "bg-[var(--color-paper-soft)]"
                      : "hover:bg-[var(--color-paper-soft)]/50"
                  }`}
                >
                  <td
                    className={`py-2 pr-3 pl-0 label-mono text-[12px] ${
                      isFastest || isReliable ? "font-bold text-ink" : "text-ink-faint"
                    }`}
                  >
                    {i + 1}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2.5">
                      <ProviderLogo slug={r.slug} name={r.name} size={20} />
                      <Link
                        href={`/products/${r.slug}`}
                        className={`hover:text-ink transition-colors text-[13px] leading-tight ${
                          isFastest || isReliable ? "font-semibold text-ink" : "text-ink-soft"
                        }`}
                      >
                        {r.name}
                      </Link>
                      {isFastest && (
                        <span className="label-mono text-[9px] bg-ink text-paper px-1.5 py-px uppercase tracking-[0.1em] shrink-0">
                          {leaderLabel}
                        </span>
                      )}
                      {isReliable && (
                        <span className="label-mono text-[9px] border border-ink text-ink px-1.5 py-px uppercase tracking-[0.1em] shrink-0">
                          RELIABLE
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    className={`py-2 pr-3 text-right label-mono tabular-nums ${
                      isFastest ? "text-[14px] font-bold text-ink" : "text-[13px] text-ink-soft"
                    }`}
                  >
                    {fmtUnit(r.ms.p50, b.unit)}
                  </td>
                  {hasSuccess && (
                    <td className={`py-2 text-right label-mono text-[13px] tabular-nums ${successColor}`}>
                      <span className="flex items-center justify-end gap-2">
                        <span
                          className="hidden sm:block h-1 rounded-full bg-current opacity-25 shrink-0"
                          style={{ width: `${Math.round(successPct * 0.4)}px` }}
                        />
                        {successPct.toFixed(1)}%
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {caption && (
        <figcaption className="mt-3 flex items-start gap-4 justify-between">
          <p className="text-xs text-ink-muted leading-relaxed">{caption}</p>
          <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
            <Link
              className="label-mono text-[10px] text-ink-muted hover:text-ink transition-colors whitespace-nowrap"
              href={`/benchmarks/${bench}`}
            >
              Live data
            </Link>
          </div>
        </figcaption>
      )}
    </figure>
  );
}
