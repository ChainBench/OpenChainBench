import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { GLOSSARY, getGlossaryEntry, getGlossarySlugs } from "@/data/glossary";
import { SITE } from "@/data/site";

type Params = { term: string };

export function generateStaticParams() {
  return getGlossarySlugs().map((term) => ({ term }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { term } = await params;
  const entry = getGlossaryEntry(term);
  if (!entry) return {};
  const url = `${SITE.url}/glossary/${entry.slug}`;
  return {
    title: entry.term,
    description: entry.short,
    alternates: { canonical: url },
    openGraph: { title: entry.term, description: entry.short, type: "article", url },
    twitter: { card: "summary", title: entry.term, description: entry.short },
  };
}

export default async function GlossaryTermPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { term } = await params;
  const entry = getGlossaryEntry(term);
  if (!entry) notFound();

  const paragraphs = entry.body.split(/\n\n+/);
  const related = (entry.related ?? [])
    .map((slug) => GLOSSARY.find((g) => g.slug === slug))
    .filter((g): g is (typeof GLOSSARY)[number] => Boolean(g));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    "@id": `${SITE.url}/glossary/${entry.slug}`,
    name: entry.term,
    description: entry.short,
    inDefinedTermSet: {
      "@type": "DefinedTermSet",
      name: "OpenChainBench Glossary",
      url: `${SITE.url}/glossary`,
    },
  };

  return (
    <article className="mx-auto max-w-3xl px-6 pt-10 sm:pt-14 pb-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Link
        href="/glossary"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} />
        All terms
      </Link>

      <header className="mt-6 border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">{entry.term}</h1>
        <p className="mt-3 text-base sm:text-lg text-ink-soft leading-snug">{entry.short}</p>
      </header>

      <div className="mt-8 space-y-5 text-base leading-relaxed text-ink-soft">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      {(related.length > 0 || (entry.seeAlso && entry.seeAlso.length > 0)) && (
        <footer className="mt-12 border-t border-rule pt-6 grid gap-6 sm:grid-cols-2">
          {related.length > 0 && (
            <div>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
                Related terms
              </h2>
              <ul className="mt-3 space-y-1">
                {related.map((r) => (
                  <li key={r.slug}>
                    <Link className="lnk text-sm" href={`/glossary/${r.slug}`}>
                      {r.term}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {entry.seeAlso && entry.seeAlso.length > 0 && (
            <div>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
                Seen in
              </h2>
              <ul className="mt-3 space-y-1">
                {entry.seeAlso.map((slug) => (
                  <li key={slug}>
                    <Link className="lnk text-sm" href={`/benchmarks/${slug}`}>
                      /benchmarks/{slug}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </footer>
      )}
    </article>
  );
}
