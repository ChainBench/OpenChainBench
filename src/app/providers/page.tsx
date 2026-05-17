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

  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16">
      <header className="mb-10">
        <h1 className="display text-4xl sm:text-5xl text-ink">Providers</h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Every provider that appears in at least one live benchmark.
          Sorted by number of #1 finishes, then by reach across categories.
        </p>
      </header>
      <ProvidersTable providers={rows} />
    </article>
  );
}
