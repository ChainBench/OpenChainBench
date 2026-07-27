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

  const rows = REGIONS.map((region, i) => {
    const b = results[i];
    if (!b || b.editorialStatus !== "live") return { region, fastest: null, reliable: null };
    const ranked = rankedCandidates(b);
    if (!ranked.length) return { region, fastest: null, reliable: null };

    const fastest = ranked[0];
    const reliable = [...ranked].sort(
      (a, c) => (c.successRate ?? 0) - (a.successRate ?? 0)
    )[0];
    const sameProvider = fastest.slug === reliable.slug;

    return { region, fastest, reliable: sameProvider ? null : reliable };
  });

  return (
    <figure className="my-10 not-prose">
      <div className="border-t-[2px] border-ink grid grid-cols-3 divide-x divide-rule">
        {rows.map(({ region, fastest, reliable }) => (
          <div key={region.key} className="px-4 pt-4 pb-5">
            <p className="label-mono text-[10px] uppercase tracking-[0.18em] text-ink mb-0.5">
              {region.label}
            </p>
            <p className="label-mono text-[10px] text-ink-faint mb-4">{region.sub}</p>

            {fastest ? (
              <div className="space-y-3">
                <div>
                  <p className="label-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint mb-1.5">
                    Fastest
                  </p>
                  <div className="flex items-center gap-2">
                    <ProviderLogo slug={fastest.slug} name={fastest.name} size={16} />
                    <Link
                      href={`/products/${fastest.slug}`}
                      className="text-[13px] font-semibold text-ink hover:underline leading-tight"
                    >
                      {fastest.name}
                    </Link>
                  </div>
                  <p className="label-mono text-[11px] text-ink-soft mt-1 tabular-nums">
                    {fastest.ms.p50 != null ? `${Math.round(fastest.ms.p50)} ms` : "—"}
                  </p>
                </div>

                {reliable && (
                  <div>
                    <p className="label-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint mb-1.5">
                      Most reliable
                    </p>
                    <div className="flex items-center gap-2">
                      <ProviderLogo slug={reliable.slug} name={reliable.name} size={16} />
                      <Link
                        href={`/products/${reliable.slug}`}
                        className="text-[13px] font-semibold text-ink hover:underline leading-tight"
                      >
                        {reliable.name}
                      </Link>
                    </div>
                    <p className="label-mono text-[11px] text-ink-soft mt-1 tabular-nums">
                      {reliable.successRate != null
                        ? `${reliable.successRate.toFixed(1)}% success`
                        : "—"}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-ink-muted italic">No data</p>
            )}
          </div>
        ))}
      </div>
      <figcaption className="mt-3 flex items-center justify-between gap-4">
        <p className="text-xs text-ink-muted leading-relaxed">
          Per-region leader for Ethereum RPC — live data, updated every 60 s.
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
