import type { Benchmark } from "@/types/benchmark";
import { leader } from "@/lib/citation";
import { fmtUnit } from "@/lib/format";
import { SITE } from "@/data/site";

/**
 * Wikipedia-style infobox for benchmark pages. A compact `<table>` of
 * key/value pairs that sits directly under the H1/subtitle and above the
 * TL;DR grounding trace.
 *
 * Why this shape:
 *  - LLM crawlers (Perplexity, Gemini, ChatGPT-with-web) extract Wikipedia
 *    infoboxes almost verbatim because they are `<table>` markup with
 *    `<th>`/`<td>` label/value pairs sitting above the fold, before any
 *    prose. Copying the shape is the single highest-leverage change
 *    identified in the July 2026 GEO deep-dive.
 *  - Users get a two-second scan of the key facts (leader, metric, last
 *    measured, license) without scrolling into the leaderboard body, so
 *    the UX gain is real and not just an SEO trick.
 *  - `itemscope` + `itemtype="https://schema.org/Dataset"` layers a
 *    microdata graph over the DOM in addition to the JSON-LD block, which
 *    some crawlers prefer.
 *
 * Hidden gracefully when the bench has no defensible leader (draft,
 * insufficient, awaiting first run) so the rendered box never publishes
 * a fabricated leader row.
 */
export function BenchInfobox({ benchmark }: { benchmark: Benchmark }) {
  const top = leader(benchmark);
  const providerCount = benchmark.results.filter(
    (r) => r.availability !== "unavailable" && r.ms.p50 > 0,
  ).length;
  const lastRunIso = benchmark.lastRunAt
    ? new Date(benchmark.lastRunAt).toISOString()
    : null;
  const lastRunDisplay = lastRunIso ? lastRunIso.replace("T", " ").slice(0, 19) + " UTC" : "n/a";

  return (
    <aside
      aria-label={`${benchmark.title} at a glance`}
      className="mt-6 max-w-md sm:float-right sm:ml-6 sm:mb-4 w-full sm:w-[22rem]"
      itemScope
      itemType="https://schema.org/Dataset"
    >
      <table
        className="w-full text-[12.5px] border-collapse card-soft rounded-lg overflow-hidden"
        style={{ borderColor: "var(--color-ink-10, rgba(0,0,0,.08))" }}
      >
        <caption className="sr-only" itemProp="name">
          {benchmark.title} at a glance
        </caption>
        <tbody>
          <InfoRow label="Benchmark">
            <span itemProp="identifier">#{benchmark.number}</span>
            {" · "}
            <span className="text-ink-faint">{benchmark.category}</span>
          </InfoRow>
          <InfoRow label="Metric">
            <span itemProp="variableMeasured">{benchmark.metric}</span>
            {benchmark.unit ? (
              <span className="text-ink-faint"> ({benchmark.unit})</span>
            ) : null}
          </InfoRow>
          {top && (
            <InfoRow label="Leader (24h)">
              <span className="font-medium text-ink">{top.name}</span>
              <span className="text-ink-faint">
                {" · "}
                {fmtUnit(top.value, benchmark.unit)}
              </span>
            </InfoRow>
          )}
          <InfoRow label="Providers">
            {providerCount} tracked
          </InfoRow>
          {lastRunIso && (
            <InfoRow label="Last measured">
              <time dateTime={lastRunIso} itemProp="dateModified">
                {lastRunDisplay}
              </time>
            </InfoRow>
          )}
          <InfoRow label="License">
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              className="underline decoration-ink/20 hover:decoration-ink"
              rel="noopener"
              itemProp="license"
            >
              CC-BY-4.0
            </a>
          </InfoRow>
          <InfoRow label="Dataset DOI">
            <a
              href="https://doi.org/10.5281/zenodo.20800312"
              className="underline decoration-ink/20 hover:decoration-ink tabular-nums"
              rel="noopener"
              itemProp="sameAs"
            >
              10.5281/zenodo.20800312
            </a>
          </InfoRow>
          <InfoRow label="Live JSON">
            <a
              href={`${SITE.url}/api/stat/${benchmark.slug}`}
              className="underline decoration-ink/20 hover:decoration-ink font-mono text-[11.5px]"
              rel="noopener"
              itemProp="distribution"
            >
              /api/stat/{benchmark.slug}
            </a>
          </InfoRow>
        </tbody>
      </table>
    </aside>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <tr className="border-t border-ink/5 first:border-t-0">
      <th
        scope="row"
        className="w-[9.5rem] px-3 py-2 text-left font-medium uppercase tracking-wide text-[10.5px] text-ink-faint bg-paper-soft/50"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {label}
      </th>
      <td className="px-3 py-2 text-ink">{children}</td>
    </tr>
  );
}
