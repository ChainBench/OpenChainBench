import type { Metadata } from "next";
import { getProviders } from "@/lib/providers";
import { ProvidersTable } from "@/components/providers-table";

export const metadata: Metadata = {
  title: "Providers",
  description:
    "Every provider tracked by OpenChainBench, grouped by performance. Click a name for its full benchmark record.",
};

export const revalidate = 60;

export default async function ProvidersIndex() {
  const providers = await getProviders();
  const rows = providers.map((p) => ({
    slug: p.slug,
    name: p.name,
    type: p.type,
    appearances: p.appearances.length,
    wins: p.wins,
    categories: p.categories,
  }));
  const total = rows.length;

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
          <ProvidersTable providers={rows} />
        )}
      </div>
    </div>
  );
}
