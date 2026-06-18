/**
 * Server component rendered on /products/[slug] between the live bench
 * leaderboard and the embeddable badges. Two stacked sections:
 *
 *  • Compare with. Cards for every provider that shares a bench with
 *    this product, each linking to /compare/<canonical-pair>.
 *  • Alternatives lists featuring this provider. Plain links into the
 *    /alternatives pages whose benchmark includes this provider.
 *
 * Both lists are computed by `src/lib/related-providers.ts` and stay in
 * sync with the live bench catalog and the alternatives directory with
 * no manual upkeep.
 */

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import {
  getCompareCandidates,
  getAlternativesFeaturing,
} from "@/lib/related-providers";

type Props = {
  providerSlug: string;
  providerName: string;
};

export async function RelatedProvidersSection({
  providerSlug,
  providerName,
}: Props) {
  const [candidates, alternatives] = await Promise.all([
    getCompareCandidates(providerSlug),
    getAlternativesFeaturing(providerSlug),
  ]);

  return (
    <>
      <section className="mt-12">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          Compare {providerName} to alternatives
        </h2>
        {candidates.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No comparable providers yet.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-soft leading-snug max-w-2xl">
              Pick a head to head pair to see {providerName} and a competitor
              side by side across every benchmark they share.
            </p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {candidates.map((c) => (
                <li key={c.slug}>
                  <Link
                    href={`/compare/${c.pairSlug}`}
                    className="card-soft p-4 flex items-center gap-3 h-full hover:border-ink/40 transition-colors"
                  >
                    <ProviderLogo slug={c.slug} name={c.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink leading-tight truncate">
                        {c.name}
                      </p>
                      <p className="font-sans label-mono-xs font-medium">
                        {c.sharedCount} shared{" "}
                        {c.sharedCount === 1 ? "benchmark" : "benchmarks"}
                      </p>
                    </div>
                    <ArrowUpRight
                      size={14}
                      strokeWidth={2}
                      className="shrink-0 text-ink-faint"
                    />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
              <Link href="/compare" className="lnk">
                Browse every head to head pair
                <ArrowUpRight
                  size={11}
                  strokeWidth={2}
                  className="inline ml-1"
                />
              </Link>
            </p>
          </>
        )}
      </section>

      {alternatives.length > 0 && (
        <section className="mt-12">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            Alternatives lists featuring {providerName}
          </h2>
          <ul className="mt-4 flex flex-col gap-1.5 border-y border-rule py-4">
            {alternatives.map((a) => (
              <li key={a.slug}>
                <Link
                  href={`/alternatives/${a.slug}`}
                  className="text-sm text-ink-soft hover:text-ink"
                >
                  <span aria-hidden="true" className="text-ink-faint mr-2">
                    {"→"}
                  </span>
                  Alternatives to {a.targetProduct}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
