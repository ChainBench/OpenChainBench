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
    <figure className="my-8 overflow-x-auto not-prose">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b-2 border-ink">
            <th className="text-left py-2 pr-3 label-mono text-ink-muted font-medium w-6">
              #
            </th>
            <th className="text-left py-2 pr-3 label-mono text-ink-muted font-medium">
              Provider
            </th>
            <th className="text-right py-2 pr-3 label-mono text-ink-muted font-medium">
              p50 ({b.unit})
            </th>
            {hasSuccess && (
              <th className="text-right py-2 label-mono text-ink-muted font-medium">
                Success
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {ranked.map((r, i) => {
            const isBest = i === 0;
            return (
              <tr
                key={r.slug}
                className={`border-b border-rule ${isBest ? "text-ink" : "text-ink-soft"}`}
              >
                <td className="py-2 pr-3 label-mono text-ink-faint">{i + 1}</td>
                <td className="py-2 pr-3">
                  <Link
                    href={`/products/${r.slug}`}
                    className="hover:text-ink transition-colors"
                  >
                    {r.name}
                  </Link>
                  {isBest && (
                    <span className="ml-2 label-mono text-[10px] border border-ink px-1 py-0.5 text-ink">
                      LEADER
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-right label-mono">
                  {fmtUnit(r.ms.p50, b.unit)}
                </td>
                {hasSuccess && (
                  <td
                    className={`py-2 text-right label-mono ${
                      (r.successRate ?? 100) < 90
                        ? "text-amber-600 dark:text-amber-400"
                        : ""
                    }`}
                  >
                    {(r.successRate ?? 100).toFixed(1)}%
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {caption && (
        <figcaption className="mt-3 text-xs text-ink-muted leading-relaxed">
          {caption} · Live data ·{" "}
          <Link className="lnk" href={`/benchmarks/${bench}`}>
            Full benchmark
          </Link>
        </figcaption>
      )}
    </figure>
  );
}
