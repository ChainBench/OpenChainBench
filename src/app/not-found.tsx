import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-16 sm:py-24">
      <p className="label-mono text-ink-faint">404</p>
      <h1 className="mt-3 display text-3xl sm:text-4xl text-ink leading-[1.05]">
        This page does not exist.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        The benchmark or page you are looking for may have moved. Every live
        benchmark is listed on the benchmarks index.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-4 text-sm">
        <Link
          href="/benchmarks"
          className="inline-flex items-center gap-1.5 text-ink-muted hover:text-ink"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          All benchmarks
        </Link>
        <Link href="/products" className="text-ink-muted hover:text-ink">
          Products
        </Link>
        <Link href="/methodology" className="text-ink-muted hover:text-ink">
          Methodology
        </Link>
        <Link href="/" className="text-ink-muted hover:text-ink">
          Home
        </Link>
      </div>
    </article>
  );
}
