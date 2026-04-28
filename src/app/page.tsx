import Link from "next/link";
import { getBenchmarks, formatLastRun } from "@/data/benchmarks";
import { RangeChart } from "@/components/range-chart";
import { Sparkline } from "@/components/sparkline";
import { Figure } from "@/components/figure";
import { fmtUnit } from "@/lib/format";

export default async function HomePage() {
  const benchmarks = await getBenchmarks();
  const featured = benchmarks[0];
  const rest = benchmarks.slice(1);
  const winner = featured.results.find((r) => r.highlight === "winner");
  const fieldP50 =
    featured.results.reduce((s, r) => s + r.ms.p50, 0) / featured.results.length;

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      {/* Front-page hero */}
      <section className="grid gap-8 md:grid-cols-12">
        <div className="md:col-span-8">
          <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
            Lead investigation · {featured.category}
          </p>
          <h2 className="mt-3 font-serif text-4xl sm:text-5xl md:text-6xl font-bold leading-[1.02] tracking-tight">
            <Link
              href={`/benchmarks/${featured.slug}`}
              className="hover:underline decoration-2 underline-offset-4"
            >
              {featured.title}
            </Link>
          </h2>
          <p className="mt-4 font-serif italic text-xl text-ink-soft max-w-2xl">
            {featured.subtitle}
          </p>

          {/* Lead chart — front-page hero figure */}
          <div className="mt-8">
            <Figure
              number="1"
              title="Quote latency, p50 across providers"
              source={`OpenChainBench Issue 001, ${featured.sampleSize.toLocaleString()} samples`}
              note={
                <>
                  Lower is better. Range is p50 → p99; dashed line is field
                  median. Solid dot is{" "}
                  <span className="smallcaps">p50</span>; ring is{" "}
                  <span className="smallcaps">p90</span>; tick is{" "}
                  <span className="smallcaps">p99</span>.
                </>
              }
            >
              <RangeChart results={featured.results} unit={featured.unit} />
            </Figure>
          </div>

          {/* Drop-cap abstract in two columns */}
          <article className="mt-8 cols-2 font-serif text-[1.05rem] leading-[1.7] text-ink-soft dropcap">
            {featured.abstract}
          </article>

          <p className="mt-8">
            <Link
              href={`/benchmarks/${featured.slug}`}
              className="font-sans text-sm uppercase tracking-[0.18em] underline decoration-2 underline-offset-4 hover:text-accent"
            >
              Read the full report &rarr;
            </Link>
          </p>
        </div>

        {/* Sidebar */}
        <aside className="md:col-span-4 md:border-l md:border-rule md:pl-8">
          <h3 className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-muted">
            At a glance
          </h3>

          <dl className="mt-4 grid grid-cols-1 divide-y divide-rule border-y border-ink/80">
            <Glance
              label="Lead provider"
              value={winner?.name ?? "—"}
              caption={winner?.tag ?? ""}
            />
            <Glance
              label="Best p50"
              value={`${winner?.ms.p50 ?? 0} ${featured.unit}`}
              caption={`${(((fieldP50 - (winner?.ms.p50 ?? 0)) / fieldP50) * 100).toFixed(0)}% faster than field median`}
            />
            <Glance
              label="Sample size"
              value={featured.sampleSize.toLocaleString()}
              caption="across 3 regions, 24 hours"
            />
            <Glance
              label="Field"
              value={`${featured.results.length} providers`}
              caption="all run with identical inputs"
            />
          </dl>

          <h3 className="mt-8 font-sans text-[11px] uppercase tracking-[0.22em] text-ink-muted">
            Also in this issue
          </h3>
          <ul className="mt-3 divide-y divide-rule">
            {rest.map((b) => {
              const w = b.results.find((r) => r.highlight === "winner");
              const series = w ? b.extras.series24h[w.slug] : undefined;
              return (
                <li key={b.slug} className="py-4">
                  <p className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                    Bench №&nbsp;{b.number} · {b.category}
                  </p>
                  <Link
                    href={`/benchmarks/${b.slug}`}
                    className="mt-1 block font-serif text-xl font-semibold leading-tight hover:text-accent"
                  >
                    {b.title}
                  </Link>
                  <p className="mt-1 font-serif italic text-sm text-ink-soft line-clamp-2">
                    {b.subtitle}
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    {series && (
                      <Sparkline values={series} emphasis width={80} height={20} />
                    )}
                    <p className="font-mono text-[11px] tabular text-ink-muted">
                      {w?.name} · {w ? fmtUnit(w.ms.p50, b.unit) : "—"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-6 border-t-2 border-double border-ink pt-4">
            <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-muted">
              From the editor
            </p>
            <p className="mt-2 font-serif italic text-sm text-ink-soft">
              Every harness is open-source. Every dataset is downloadable. If
              we got it wrong, file an issue — we'll publish the correction in
              the next edition.
            </p>
          </div>
        </aside>
      </section>

      {/* Editorial pillars */}
      <section className="mt-16 border-y-2 border-ink py-10">
        <div className="grid gap-8 md:grid-cols-3">
          <Pillar
            n="I"
            title="Open methodology"
            body="Every benchmark ships with the script that produced it. Re-run it on your own infra; if our numbers don't match yours, we want to know."
          />
          <Pillar
            n="II"
            title="Reproducible runs"
            body="Inputs, regions, cadence and timeouts are pinned. Raw transcripts are stored so any single data point can be audited after the fact."
          />
          <Pillar
            n="III"
            title="Independent edit"
            body="Mobula sponsors the infrastructure costs; OpenChainBench keeps editorial control. Sponsor results are reported the same way as competitors."
          />
        </div>
      </section>

      {/* All benchmarks index */}
      <section id="latest" className="mt-16">
        <div className="flex items-end justify-between border-b-2 border-ink pb-3">
          <h3 className="font-serif text-3xl font-bold">All benchmarks</h3>
          <Link
            href="/benchmarks"
            className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink-soft lnk"
          >
            Index of issues &rarr;
          </Link>
        </div>

        <ul className="mt-6 grid gap-px bg-rule border border-rule sm:grid-cols-2 lg:grid-cols-3">
          {benchmarks.map((b) => {
            const w = b.results.find((r) => r.highlight === "winner");
            const series = w ? b.extras.series24h[w.slug] : undefined;
            return (
              <li key={b.slug} className="bg-paper p-5">
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
                <p className="mt-2 font-serif italic text-sm text-ink-soft line-clamp-3">
                  {b.subtitle}
                </p>
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-3">
                  <p className="font-mono text-[10px] tabular text-ink-muted">
                    {w?.name} · {w ? fmtUnit(w.ms.p50, b.unit) : "—"}
                  </p>
                  {series && (
                    <Sparkline values={series} emphasis width={70} height={18} />
                  )}
                </div>
                <p className="mt-2 font-mono text-[10px] tabular text-ink-faint">
                  Updated {formatLastRun(b.lastRunAt)}
                </p>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Pillar({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <p className="font-serif text-3xl text-ink-muted">{n}.</p>
      <h4 className="mt-1 font-serif text-xl font-semibold">{title}</h4>
      <p className="mt-2 font-serif text-[1rem] leading-relaxed text-ink-soft">
        {body}
      </p>
    </div>
  );
}

function Glance({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <div className="py-3">
      <dt className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </dt>
      <dd className="mt-1 font-serif text-xl font-semibold tabular">{value}</dd>
      {caption && (
        <p className="mt-0.5 font-serif italic text-sm text-ink-soft">{caption}</p>
      )}
    </div>
  );
}
