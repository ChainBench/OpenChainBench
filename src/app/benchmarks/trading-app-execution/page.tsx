import type { Metadata } from "next";
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import Link from "next/link";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd, buildFaqPageJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";
import { fetchExecLeaderboard } from "@/lib/solana-exec";
import { ExecBenchTable } from "@/components/exec-bench-table";

export const revalidate = 60;

type BenchMeta = {
  faq: { q: string; a: string }[];
  methodology: string[];
  findings: string[];
  subtitle: string;
};

function loadBenchMeta(): BenchMeta {
  const raw = readFileSync(
    join(process.cwd(), "benchmarks/trading-app-execution.yml"),
    "utf-8",
  );
  return yaml.load(raw) as BenchMeta;
}

export const metadata: Metadata = pageMetadata({
  path: "/benchmarks/trading-app-execution",
  title:
    "Trading App Execution Quality: Axiom vs GMGN vs Trojan vs Maestro | OpenChainBench",
  description:
    "Compare on-chain execution quality for Solana trading apps: Jito rate, CU price, priority fee, platform fee. Axiom vs GMGN vs Trojan vs Maestro, measured passively from fee accounts.",
});

export default async function TradingAppExecutionPage() {
  const [data, meta] = await Promise.all([
    fetchExecLeaderboard(),
    Promise.resolve(loadBenchMeta()),
  ]);

  const breadcrumb = buildBreadcrumbJsonLd([
    { name: "Home", item: SITE.url },
    { name: "Benchmarks", item: `${SITE.url}/benchmarks` },
    {
      name: "Trading App Execution",
      item: `${SITE.url}/benchmarks/trading-app-execution`,
    },
  ]);

  const faqJsonLd = buildFaqPageJsonLd(
    meta.faq,
    `${SITE.url}/benchmarks/trading-app-execution`,
  );

  return (
    <article className="mx-auto max-w-[900px] px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            ...breadcrumb,
          }),
        }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }}
        />
      )}

      <nav className="flex items-center gap-1.5 text-xs text-ink-muted mb-6 font-mono">
        <Link href="/" className="hover:text-ink-soft transition-colors">
          Home
        </Link>
        <span>/</span>
        <Link
          href="/benchmarks"
          className="hover:text-ink-soft transition-colors"
        >
          Benchmarks
        </Link>
        <span>/</span>
        <span className="text-ink">Trading App Execution</span>
      </nav>

      <div className="flex items-start gap-3 flex-wrap">
        <span
          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium text-white shrink-0 mt-0.5"
          style={{ backgroundColor: "#a05688" }}
        >
          Trading
        </span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20 shrink-0 mt-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          Live
        </span>
      </div>

      <h1 className="display text-3xl sm:text-4xl text-ink leading-[1.05] mt-3">
        Trading app execution quality.
      </h1>
      <p className="mt-4 max-w-2xl text-base text-ink-soft leading-snug">
        {meta.subtitle}
      </p>

      <div className="mt-10">
        <ExecBenchTable data={data} />
      </div>

      <div className="mt-10 border-t border-rule pt-8 text-xs text-ink-muted leading-relaxed max-w-2xl space-y-2">
        <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-3">
          Methodology
        </p>
        {meta.methodology.map((item, i) => {
          const colonIdx = item.indexOf(": ");
          if (colonIdx === -1) return <p key={i}>{item}</p>;
          const label = item.slice(0, colonIdx);
          const rest = item.slice(colonIdx + 2);
          return (
            <p key={i}>
              <strong>{label}</strong>: {rest}
            </p>
          );
        })}
        <p className="text-ink-faint mt-3">
          Source:{" "}
          <a
            href="https://github.com/ChainBench/OpenChainBench/tree/main/harnesses/solana-exec"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-ink-muted transition-colors"
          >
            github.com/ChainBench/OpenChainBench
          </a>
          . Bench #204.
        </p>
      </div>

      <div className="mt-10 border-t border-rule pt-8 max-w-2xl">
        <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-5">
          FAQ
        </p>
        <div className="space-y-6">
          {meta.faq.map((item) => (
            <div key={item.q}>
              <p className="font-medium text-sm text-ink mb-1">{item.q}</p>
              <p className="text-sm text-ink-soft leading-relaxed">{item.a}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10 pt-6 border-t border-rule">
        <Link
          href="/apps"
          className="text-sm text-ink-muted hover:text-ink-soft transition-colors"
        >
          Back to trading app revenue
        </Link>
      </div>
    </article>
  );
}
