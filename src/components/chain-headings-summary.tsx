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
 * Only renders for benches whose results ARE chains — i.e. the
 * provider slug matches an entry in the spec's findings about
 * consensus. For aggregator / bridge benches the heading shape
 * differs and is not generated here.
 *
 * No-op when the bench has no live data yet.
 */
export function ChainHeadingsSummary({ benchmark }: { benchmark: Benchmark }) {
  const liveResults = benchmark.results.filter((r) => r.ms.p50 > 0);
  if (liveResults.length === 0) return null;

  // Heuristic: only render for benches whose metric is a chain-property
  // measurement (finality, latency, consensus, coverage). Skip benches
  // where providers are aggregators/bridges/protocols (perp-fees, etc.).
  const isChainBench = /finality|consensus|coverage|latency/i.test(
    benchmark.metric
  );
  if (!isChainBench) return null;

  // Sort by p50: best-first when lower-is-better, worst-first otherwise.
  const sorted = [...liveResults].sort((a, b) =>
    benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50
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
        its own consensus mechanism — the explainer below matches what the
        harness actually measures.
      </p>

      <div className="mt-8 space-y-7">
        {sorted.map((r) => (
          <article key={r.slug}>
            <h3 className="display text-xl tracking-tight text-ink">
              {r.name} {benchmark.metric.toLowerCase()}
            </h3>
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
          </article>
        ))}
      </div>
    </section>
  );
}
