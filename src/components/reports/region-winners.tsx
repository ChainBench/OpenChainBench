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
    if (!b || b.editorialStatus !== "live") return { region, ranked: [] as ReturnType<typeof rankedCandidates> };
    return { region, ranked: rankedCandidates(b) };
  });

  const anyData = columns.some((c) => c.ranked.length > 0);
  if (!anyData) return null;

  // Build a unified list of providers with per-region rank and p50
  const slugsSeen = new Set<string>();
  const providerMeta: Record<string, { name: string }> = {};
  for (const { ranked } of columns) {
    for (const r of ranked) {
      slugsSeen.add(r.slug);
      providerMeta[r.slug] = { name: r.name };
    }
  }

  type ProviderRow = {
    slug: string;
    name: string;
    regions: Array<{ p50: number | null; rank: number | null }>;
    wins: number;
  };

  const rows: ProviderRow[] = Array.from(slugsSeen).map((slug) => {
    const regions = columns.map(({ ranked }) => {
      const idx = ranked.findIndex((r) => r.slug === slug);
      if (idx === -1) return { p50: null, rank: null };
      return { p50: ranked[idx].ms.p50 ?? null, rank: idx };
    });
    const wins = regions.filter((r) => r.rank === 0).length;
    return { slug, name: providerMeta[slug].name, regions, wins };
  });

  // Sort: most wins first, then by sum of p50s ascending (faster overall = higher)
  rows.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const sumA = a.regions.reduce((s, r) => s + (r.p50 ?? Infinity), 0);
    const sumB = b.regions.reduce((s, r) => s + (r.p50 ?? Infinity), 0);
    return sumA - sumB;
  });

  return (
    <figure className="my-10 not-prose">
      <div className="border-t-[2px] border-ink overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-2.5 pr-3 pl-0 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium w-6">#</th>
              <th className="text-left py-2.5 pr-4 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium">
                Provider
              </th>
              {REGIONS.map((region) => (
                <th
                  key={region.key}
                  className="text-right py-2.5 pr-4 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium"
                >
                  {region.label}
                  <span className="normal-case text-ink-faint ml-1 hidden sm:inline">({region.sub})</span>
                </th>
              ))}
              <th className="text-right py-2.5 pl-2 label-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted font-medium">
                Wins
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const highlight = row.wins > 0;
              return (
                <tr
                  key={row.slug}
                  className={`border-b border-rule transition-colors ${
                    highlight ? "bg-[var(--color-paper-soft)]" : "hover:bg-[var(--color-paper-soft)]/50"
                  }`}
                >
                  <td className={`py-2 pr-3 pl-0 label-mono text-[12px] ${highlight ? "font-bold text-ink" : "text-ink-faint"}`}>
                    {i + 1}
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderLogo slug={row.slug} name={row.name} size={16} />
                      <Link
                        href={`/products/${row.slug}`}
                        className={`text-[13px] leading-tight hover:text-ink transition-colors truncate ${highlight ? "font-semibold text-ink" : "text-ink-soft"}`}
                      >
                        {row.name}
                      </Link>
                    </div>
                  </td>
                  {row.regions.map((reg, ri) => {
                    const isWinner = reg.rank === 0;
                    return (
                      <td
                        key={REGIONS[ri].key}
                        className={`py-2 pr-4 text-right label-mono tabular-nums ${
                          isWinner ? "text-[13px] font-bold text-ink" : "text-[12px] text-ink-soft"
                        }`}
                      >
                        {reg.p50 != null ? `${Math.round(reg.p50)} ms` : "—"}
                      </td>
                    );
                  })}
                  <td className="py-2 pl-2 text-right label-mono tabular-nums">
                    {row.wins > 0 ? (
                      <span className="text-[13px] font-bold text-ink">{row.wins}/{REGIONS.length}</span>
                    ) : (
                      <span className="text-[12px] text-ink-faint">0/{REGIONS.length}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-3 flex items-center justify-between gap-4">
        <p className="text-xs text-ink-muted leading-relaxed">
          p50 latency per probe region. Bold = fastest in that region. Wins = number of regions led.
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
