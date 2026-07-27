import Link from "next/link";
import { getBenchmark } from "@/data/benchmarks";
import { rankedCandidates } from "@/lib/citation";
import { ProviderLogo } from "@/components/provider-logo";

const REGIONS = [
  { key: "us-east", label: "US-East", sub: "Virginia" },
  { key: "eu-west", label: "EU-West", sub: "Amsterdam" },
  { key: "sgp", label: "Singapore", sub: "Asia-Pacific" },
];

type Props = { bench: string };

export async function RegionWinners({ bench }: Props) {
  const results = await Promise.all(
    REGIONS.map((r) =>
      getBenchmark(bench, { region: r.key }).catch(() => undefined)
    )
  );

  const columns = REGIONS.map((region, i) => {
    const b = results[i];
    if (!b || b.editorialStatus !== "live") return { region, ranked: [] };
    return { region, ranked: rankedCandidates(b) };
  });

  const anyData = columns.some((c) => c.ranked.length > 0);
  if (!anyData) return null;

  const maxRows = Math.max(...columns.map((c) => c.ranked.length));

  return (
    <figure className="my-10 not-prose">
      <div className="border-t-[2px] border-ink overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-2.5 pr-3 pl-0 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium w-6">#</th>
              {columns.map(({ region }) => (
                <th
                  key={region.key}
                  className="text-left py-2.5 pr-4 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium"
                  colSpan={2}
                >
                  {region.label}
                  <span className="normal-case text-ink-faint ml-1">({region.sub})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: maxRows }).map((_, i) => (
              <tr key={i} className="border-b border-rule hover:bg-[var(--color-paper-soft)]/50 transition-colors">
                <td className="py-2 pr-3 pl-0 label-mono text-[12px] text-ink-faint">{i + 1}</td>
                {columns.map(({ region, ranked }) => {
                  const r = ranked[i];
                  if (!r) return <td key={region.key} colSpan={2} className="py-2 pr-4" />;
                  const isFirst = i === 0;
                  return (
                    <td key={region.key} colSpan={2} className="py-2 pr-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <ProviderLogo slug={r.slug} name={r.name} size={16} />
                          <Link
                            href={`/products/${r.slug}`}
                            className={`text-[13px] leading-tight hover:text-ink transition-colors truncate ${isFirst ? "font-semibold text-ink" : "text-ink-soft"}`}
                          >
                            {r.name}
                          </Link>
                        </div>
                        <span className={`label-mono tabular-nums shrink-0 ${isFirst ? "text-[13px] font-bold text-ink" : "text-[12px] text-ink-soft"}`}>
                          {r.ms.p50 != null ? `${Math.round(r.ms.p50)} ms` : "—"}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-3 flex items-center justify-between gap-4">
        <p className="text-xs text-ink-muted leading-relaxed">
          Ethereum RPC ranked by p50 latency per probe region. Same providers, different positions and values.
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          <Link
            className="label-mono text-[10px] text-ink-muted hover:text-ink transition-colors whitespace-nowrap"
            href={`/benchmarks/${bench}`}
          >
            Live data
          </Link>
        </div>
      </figcaption>
    </figure>
  );
}
