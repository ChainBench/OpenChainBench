import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";

/**
 * Server-rendered per-provider H2 block. Each chain on a chain-shaped
 * bench (l1-finality, network-coverage, ...) gets its own crawlable
 * heading like `<h2>Ethereum finality time</h2>` followed by the live
 * p50 reading. The block sits below the live chart, where readers can
 * scroll to digest one chain at a time and search engines see the
 * exact long-tail phrases they index against ("ethereum finality
 * time", "solana finality time sub-second", "stellar finality time").
 *
 * Only renders for benches whose results ARE chains - i.e. the
 * provider slug matches an entry in the spec's findings about
 * consensus. For aggregator / bridge benches the heading shape
 * differs and is not generated here.
 *
 * No-op when the bench has no live data yet.
 */
export function ChainHeadingsSummary({ benchmark }: { benchmark: Benchmark }) {
  const liveResults = benchmark.results.filter((r) => r.availability !== "unavailable" && r.ms.p50 > 0);
  if (liveResults.length === 0) return null;

  // Render for benches whose providers ARE chains - currently the
  // "Blockchains" category (l1-finality, l2-block-time, ...). Skip
  // aggregator / bridge / trading benches where providers are
  // protocols, not chains, and the per-chain heading shape would not
  // make sense.
  if (benchmark.category !== "Blockchains") return null;

  // Sort by p50: best-first when lower-is-better, worst-first otherwise.
  const sorted = [...liveResults].sort((a, b) =>
    benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50
  );

  // Look up per-chain explainer by slug. Map for O(1) access from the
  // sort loop. When present, the slug's body is rendered as a second
  // paragraph below the live p50 line.
  const explainerBySlug = new Map(
    (benchmark.perChainExplainer ?? []).map((e) => [e.slug, e])
  );

  return (
    <section
      aria-label={`Per-chain ${benchmark.metric.toLowerCase()}`}
      className="mt-16 max-w-3xl"
    >
      <h2 className="display text-2xl tracking-tight text-ink">
        {benchmark.metric} by chain
      </h2>
      <p className="mt-3 text-sm text-ink-muted">
        Live p50 over the last 24 hours, ranked{" "}
        {benchmark.higherIsBetter ? "highest" : "lowest"} first. Each chain has
        its own consensus mechanism. The explainer below matches what the
        harness actually measures.
      </p>

      <div className="mt-8 space-y-8">
        {sorted.map((r) => {
          const explainer = explainerBySlug.get(r.slug);
          // Heading: prefer the YAML-declared H2 string when present (it
          // can phrase the heading more naturally than the default
          // "{name} {metric}" template). Each heading gets an id={slug}
          // so URLs like /benchmarks/l1-finality#ethereum land at the
          // exact section, which directly answers GSC long-tail queries.
          const heading =
            explainer?.h2 ?? `${r.name} ${benchmark.metric.toLowerCase()}`;
          return (
            <article key={r.slug} id={r.slug} className="scroll-mt-20">
              <h2 className="display text-xl tracking-tight text-ink">
                {heading}
              </h2>
              <p className="mt-2 text-base leading-relaxed text-ink-soft">
                <span className="font-semibold text-ink">
                  {fmtUnit(r.ms.p50, benchmark.unit)}
                </span>{" "}
                p50 over the last 24 hours
                {r.successRate < 99
                  ? ` · ${r.successRate.toFixed(1)}% success rate`
                  : ""}
                {r.tag ? ` · ${r.tag}` : ""}
                .
              </p>
              {explainer?.body && (
                <p className="mt-3 text-base leading-relaxed text-ink-soft">
                  {explainer.body}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
