import Link from "next/link";
import { getBenchmarks, formatLastRun, getLeader } from "@/data/benchmarks";
import { Sparkline } from "@/components/sparkline";
import { fmtUnit } from "@/lib/format";

export default async function HomePage() {
  const benchmarks = await getBenchmarks();

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      {/* Hero */}
      <section className="grid gap-8 md:grid-cols-12 md:items-end">
        <div className="md:col-span-8">
          <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
            The journal
          </p>
          <h2 className="mt-3 font-serif text-4xl sm:text-5xl md:text-6xl font-bold leading-[1.02] tracking-tight">
            Open benchmarks for crypto infrastructure.
          </h2>
          <p className="mt-4 font-serif italic text-xl text-ink-soft max-w-2xl">
            Latency, accuracy and reliability for aggregators, bridges, RPCs
            and price feeds — measured the same way every time, with the
            scripts that produced the numbers published alongside.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-sans text-sm">
            <Link
              href="/benchmarks"
              className="inline-flex items-center gap-2 border-b-2 border-ink pb-0.5 hover:text-accent"
            >
              Read benchmarks &rarr;
            </Link>
            <Link
              href="/contribute"
              className="lnk text-ink-soft hover:text-ink"
            >
              Submit your own
            </Link>
            <a
              className="lnk text-ink-soft hover:text-ink"
              href="https://github.com/Flotapponnier/OpenChainBench"
            >
              GitHub ↗
            </a>
          </div>
        </div>

        <aside className="md:col-span-4 md:border-l md:border-rule md:pl-8">
          <h3 className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-muted">
            How it works
          </h3>
          <ol className="mt-3 space-y-3 font-serif text-[1rem] leading-relaxed text-ink-soft">
            <li>
              <span className="font-mono text-[10px] tabular text-ink-muted mr-2">
                01
              </span>
              A YAML spec describes what to measure and which Prometheus
              queries hold the numbers.
            </li>
            <li>
              <span className="font-mono text-[10px] tabular text-ink-muted mr-2">
                02
              </span>
              Each benchmark&apos;s harness pushes metrics from three regions
              every few minutes.
            </li>
            <li>
              <span className="font-mono text-[10px] tabular text-ink-muted mr-2">
                03
              </span>
              The site re-queries every minute and re-renders. The leader is
              computed live from the data.
            </li>
          </ol>
        </aside>
      </section>

      {/* All benchmarks — primary content */}
      <section id="latest" className="mt-16">
        <div className="flex items-end justify-between border-b-2 border-ink pb-3">
          <h3 className="font-serif text-3xl font-bold">Reports</h3>
          <Link
            href="/benchmarks"
            className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-soft lnk"
          >
            Full index &rarr;
          </Link>
        </div>

        {benchmarks.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="mt-6 grid gap-px bg-rule border border-rule sm:grid-cols-2 lg:grid-cols-3">
            {benchmarks.map((b) => {
              const leader = getLeader(b);
              const series = leader ? b.extras.series24h[leader.slug] : undefined;
              return (
                <li key={b.slug} className="bg-paper p-5 flex flex-col">
                  <div className="flex items-baseline justify-between font-sans text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                    <span>№&nbsp;{b.number}</span>
                    <span>{b.category}</span>
                  </div>
                  <Link
                    href={`/benchmarks/${b.slug}`}
                    className="mt-2 block font-serif text-xl font-semibold leading-tight hover:text-accent"
                  >
                    {b.title}
                  </Link>
                  <p className="mt-2 font-serif italic text-sm text-ink-soft line-clamp-3 flex-1">
                    {b.subtitle}
                  </p>
                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-3">
                    <p className="font-mono text-[10px] tabular text-ink-muted">
                      {leader
                        ? `Lead · ${leader.name} · ${fmtUnit(leader.ms.p50, b.unit)}`
                        : "Awaiting first run"}
                    </p>
                    {series && series.length > 0 && (
                      <Sparkline values={series} emphasis width={70} height={18} />
                    )}
                  </div>
                  <p className="mt-2 font-mono text-[10px] tabular text-ink-faint">
                    {b.status === "draft"
                      ? "Draft · spec published"
                      : `Updated ${formatLastRun(b.lastRunAt)}`}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Contribute band */}
      <section className="mt-16 border-y-2 border-ink py-10">
        <div className="grid gap-8 md:grid-cols-12 md:items-center">
          <div className="md:col-span-8">
            <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
              Open
            </p>
            <h3 className="mt-2 font-serif text-3xl font-bold tracking-tight">
              Submit a benchmark.
            </h3>
            <p className="mt-3 font-serif text-[1.05rem] leading-relaxed text-ink-soft max-w-xl">
              Anyone can add a benchmark. Write a YAML spec, point it at a
              Prometheus instance, open a pull request. The page renders in
              the same paper format with the leader computed from your data.
            </p>
          </div>
          <div className="md:col-span-4 flex flex-wrap items-center gap-x-6 gap-y-2 md:justify-end font-sans text-sm">
            <Link
              href="/contribute"
              className="inline-flex items-center gap-2 border-b-2 border-ink pb-0.5 hover:text-accent"
            >
              Read the tutorial &rarr;
            </Link>
            <a
              className="lnk text-ink-soft hover:text-ink"
              href="https://github.com/Flotapponnier/OpenChainBench/issues/new"
            >
              Open an issue ↗
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-8 border border-rule bg-paper-deep/50 p-8 text-center">
      <p className="font-serif italic text-lg text-ink-soft">
        No benchmark specs found yet.
      </p>
      <p className="mt-2 font-serif text-sm text-ink-muted">
        Drop a YAML file in <code className="font-mono">benchmarks/</code> and
        open a PR. The{" "}
        <Link className="lnk" href="/contribute">
          tutorial
        </Link>{" "}
        walks through the four steps.
      </p>
    </div>
  );
}
