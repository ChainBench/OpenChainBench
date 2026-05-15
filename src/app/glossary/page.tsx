import type { Metadata } from "next";
import Link from "next/link";
import { GLOSSARY } from "@/data/glossary";

export const metadata: Metadata = {
  title: "Glossary",
  description:
    "Definitions for the terms OpenChainBench uses. p50, head lag, all-in fee, finality, intent networks, and more.",
};

export default function GlossaryIndex() {
  return (
    <div className="px-4 pt-12 pb-12 sm:pt-16 sm:pb-16">
      <div className="mx-auto max-w-3xl">
        <header className="border-b-2 border-ink pb-6">
          <h1 className="display text-3xl sm:text-4xl tracking-tight">Glossary</h1>
          <p className="mt-3 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
            The technical terms used across the benchmarks, defined. Written
            for people who want to read a number with confidence about what
            it does and does not capture.
          </p>
        </header>

        <ol className="mt-10 divide-y divide-rule border-b border-rule">
          {GLOSSARY.map((g) => (
            <li key={g.slug}>
              <Link
                href={`/glossary/${g.slug}`}
                className="block py-5 pl-3 pr-3 hover:bg-paper-soft/60 transition-colors"
              >
                <h3 className="display text-lg font-semibold text-ink leading-tight">
                  {g.term}
                </h3>
                <p className="mt-1 text-sm text-ink-muted leading-relaxed">
                  {g.short}
                </p>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
