import Link from "next/link";
import { getBenchmark } from "@/data/benchmarks";
import { rankedCandidates } from "@/lib/citation";
import { fmtUnit } from "@/lib/format";

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

  return (
    <figure className="my-10 not-prose">
      <div className="border-t-[2px] border-ink overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-3 pr-3 pl-0 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium w-8">
                #
              </th>
              <th className="text-left py-3 pr-3 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium">
                Provider
              </th>
              <th className="text-right py-3 pr-3 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium">
                p50 {b.unit && <span className="normal-case">({b.unit})</span>}
              </th>
              {hasSuccess && (
                <th className="text-right py-3 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium">
                  Success
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => {
              const isBest = i === 0;
              const successPct = r.successRate ?? 100;
              const successColor =
                successPct >= 99
                  ? "text-ink"
                  : successPct >= 90
                    ? "text-ink-soft"
                    : "text-amber-600 dark:text-amber-400";

              return (
                <tr
                  key={r.slug}
                  className={`border-b border-rule transition-colors ${
                    isBest
                      ? "bg-[var(--color-paper-soft)]"
                      : "hover:bg-[var(--color-paper-soft)]/50"
                  }`}
                >
                  <td
                    className={`py-3 pr-3 pl-0 label-mono text-[13px] ${
                      isBest ? "font-bold text-ink" : "text-ink-faint"
                    }`}
                  >
                    {i + 1}
                  </td>
                  <td className="py-3 pr-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/products/${r.slug}`}
                        className={`hover:text-ink transition-colors ${
                          isBest ? "font-semibold text-ink" : "text-ink-soft"
                        }`}
                      >
                        {r.name}
                      </Link>
                      {isBest && (
                        <span className="label-mono text-[9px] bg-ink text-paper px-1.5 py-px uppercase tracking-[0.1em]">
                          LEADER
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    className={`py-3 pr-3 text-right label-mono ${
                      isBest ? "text-[15px] font-bold text-ink" : "text-[13px] text-ink-soft"
                    }`}
                  >
                    {fmtUnit(r.ms.p50, b.unit)}
                  </td>
                  {hasSuccess && (
                    <td className={`py-3 text-right label-mono text-[13px] ${successColor}`}>
                      {successPct.toFixed(1)}%
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
