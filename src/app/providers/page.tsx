import type { Metadata } from "next";
import Link from "next/link";
import { getProviders } from "@/lib/providers";
import { ProviderLogo } from "@/components/provider-logo";
import { CATEGORY_COLOR } from "@/lib/category-colors";

export const metadata: Metadata = {
  title: "Providers",
  description:
    "Every provider tracked by OpenChainBench, grouped by performance. Click a name for its full benchmark record.",
};

export const revalidate = 60;

export default async function ProvidersIndex() {
  const providers = await getProviders();
  const total = providers.length;

  return (
    <div className="px-4 pt-12 pb-12 sm:pt-16 sm:pb-16">
      <div className="mx-auto max-w-6xl">
        <header className="border-b-2 border-ink pb-6">
          <h1 className="display text-3xl sm:text-4xl tracking-tight">Providers</h1>
          <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
            Every provider that appears in at least one live benchmark.
            Sorted by number of #1 finishes, then by reach across categories.
          </p>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
            {total} {total === 1 ? "provider" : "providers"} indexed
          </p>
        </header>

        {total === 0 ? (
          <p className="mt-16 text-center text-ink-muted">
            No live providers yet.
          </p>
        ) : (
          <ol className="mt-10 divide-y divide-rule border-b border-rule">
            {providers.map((p) => (
              <li key={p.slug}>
                <Link
                  href={`/providers/${p.slug}`}
                  className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 py-5 pl-3 pr-3 hover:bg-paper-soft/60 transition-colors"
                >
                  <ProviderLogo slug={p.slug} name={p.name} size={32} />
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <h3 className="display text-base sm:text-lg font-semibold text-ink leading-tight truncate">
                        {p.name}
                      </h3>
                      {p.type && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
                          {p.type}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] tracking-wide text-ink-muted truncate">
                      {p.categories.map((c) => (
                        <span key={c} style={{ color: CATEGORY_COLOR[c] ?? "var(--color-ink-muted)" }}>
                          {c}
                        </span>
                      )).reduce<React.ReactNode[]>((acc, el, i) => {
                        if (i > 0) acc.push(<span key={`s-${i}`} className="text-ink-faint"> · </span>);
                        acc.push(el);
                        return acc;
                      }, [])}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono tabular text-sm text-ink">
                      {p.appearances.length}
                      <span className="text-ink-faint"> bench{p.appearances.length === 1 ? "" : "es"}</span>
                    </p>
                    {p.wins > 0 && (
                      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-good">
                        {p.wins} #1
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
