import Link from "next/link";
import { notFound } from "next/navigation";
import { isDevOnlyRoute } from "@/lib/removed-benches";
import { fetchTradingAgentHub } from "@/lib/trading-agent-hub";
import type { AgentRow } from "@/lib/trading-agent-hub";
import { ProviderLogo } from "@/components/provider-logo";
import { AnswersForBench } from "@/components/answers-for-bench";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

const DESCRIPTION =
  "Eight frontier models from four labs trade ETH/USDC on Base under identical rules. Live results scored net of the exposure each agent actually carried.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/trading-agents",
  title: "AI trading agents, live results by lab",
  description: DESCRIPTION,
});

export const revalidate = 3600;

export default async function TradingAgentsHubPage() {
  // Gated with the bench it reads. The aggregate blob is shared across
  // environments, so without this the table would render on production with
  // every row pointing at a 404.
  if (isDevOnlyRoute("/trading-agents")) notFound();

  const hub = await fetchTradingAgentHub();

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "AI trading agents", item: `${SITE.url}/trading-agents` },
    ]),
  };

  const itemListLd = hub
    ? {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "AI trading agent results by OpenChainBench",
        description: DESCRIPTION,
        numberOfItems: hub.labCount,
        itemListElement: hub.labs.map((l, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: l.name,
          url: `${SITE.url}/products/${l.slug}`,
        })),
      }
    : null;

  return (
    <article
      className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16"
      style={{
        background:
          "linear-gradient(180deg, rgba(16,163,127,0.05), rgba(16,163,127,0) 320px)",
      }}
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      {itemListLd && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }}
        />
      )}

      <header className="mb-8">
        <p className="label-mono text-[#10A37F] mb-2">AI trading agents</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Can an AI model trade its way past the asset it is trading?
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Eight autonomous agents trade the same ETH/USDC pair on Base, with
          real money, for six days at a time. Each one is a single harness
          built by Recall Labs wrapped around a different frontier model, so
          the roster holds everything constant except the model. The arena
          publishes who won each round. This page publishes what that cannot
          show: whether any of them beat holding the exposure they were
          already carrying.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          <Link
            href="/benchmarks/trading-agent-alpha"
            className="inline-flex items-center gap-1.5 rounded-full border border-[#10A37F]/30 bg-[#10A37F]/10 px-3 py-1 hover:bg-[#10A37F]/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench 284
            </span>
            <span className="text-ink">trading-agent-alpha</span>
          </Link>
          <span className="inline-flex items-center rounded-full border border-ink/10 px-3 py-1 text-ink-muted">
            Aerodrome spot, Base
          </span>
          <span className="inline-flex items-center rounded-full border border-ink/10 px-3 py-1 text-ink-muted">
            Weekly rounds
          </span>
        </div>
      </header>

      {hub ? (
        <>
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <SummaryCard
              label="Agents ranked"
              value={`${hub.agentCount} from ${hub.labCount} labs`}
              accent="#10A37F"
              tip="Every agent with at least ten funded rounds. Models with fewer appearances are excluded rather than averaged in."
            />
            <SummaryCard
              label="Beating their own exposure"
              value={`${hub.beatingPassive} of ${hub.agentCount}`}
              tip="Agents whose alpha is above zero. Alpha is return minus a passive position at that agent's own measured beta, over exactly the rounds it funded."
            />
            <SummaryCard
              label="Best alpha"
              value={
                hub.bestName && hub.bestAlpha != null
                  ? `${hub.bestName} · ${fmtPct(hub.bestAlpha)}`
                  : "..."
              }
              tip="Least negative, not positive. No agent in this arena is above zero."
            />
            <SummaryCard
              label="Rounds behind each row"
              value={
                hub.minRounds != null && hub.maxRounds != null
                  ? hub.minRounds === hub.maxRounds
                    ? String(hub.maxRounds)
                    : `${hub.minRounds} to ${hub.maxRounds}`
                  : "..."
              }
              tip="Agents did not all fund the same weeks, so each figure is computed over that agent's own rounds and no others."
            />
          </section>

          <section className="mb-10">
            <div className="flex items-baseline justify-between gap-4 mb-1">
              <h2 className="display text-xl sm:text-2xl text-ink">
                Results by lab
              </h2>
              <Link
                href="/benchmarks/trading-agent-alpha"
                className="text-[12px] text-ink-soft hover:text-ink underline"
              >
                full breakdown
              </Link>
            </div>
            <p className="text-sm text-ink-muted mb-4">
              Grouped by the lab that makes the model, because the arena runs
              most models twice: once fed the numbers behind a chart and once
              fed an image of it. Those two rows are one model under two input
              conditions, not two competitors. Sorted by each lab&rsquo;s best
              alpha.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm border-collapse">
                <thead>
                  <tr className="border-b-2 border-ink text-left">
                    <Th className="w-[30%]">Lab and agent</Th>
                    <Th align="right" tip="Return minus a passive position at this agent's own measured exposure, over the rounds it funded. Zero means the model added nothing.">
                      Alpha
                    </Th>
                    <Th align="right" tip="Compounded return over the rounds this agent funded.">
                      Return
                    </Th>
                    <Th align="right" tip="What holding this agent's own measured exposure would have returned over the same rounds.">
                      Same exposure held
                    </Th>
                    <Th align="right" tip="Share of funded rounds that finished above zero.">
                      Winning rounds
                    </Th>
                    <Th align="right" tip="Regression slope against ETH over the same rounds. 1.0 would be holding ETH outright.">
                      Exposure
                    </Th>
                    <Th align="right" tip="Funded rounds behind every figure on this row.">
                      Rounds
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {hub.labs.map((lab) => (
                    <LabGroup key={lab.slug} lab={lab} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[12px] text-ink-muted">
              Agent names are declared by the arena, not verified. Nothing in
              the data proves which model sits behind a name, so no row here is
              a claim about a vendor&rsquo;s product.
            </p>
          </section>

          <section className="mb-10">
            <h2 className="display text-xl sm:text-2xl text-ink mb-3">
              What these agents actually do
            </h2>
            <div className="grid sm:grid-cols-3 gap-4">
              <ArchCard
                label="One pair, six days"
                body="Each round is a fresh self-funded wallet trading ETH against USDC through Aerodrome on Base. No shorting, no leverage, no other token. An agent's only decision is how much of the wallet sits in ETH at any moment, which is why its measured exposure is the thing worth subtracting."
              />
              <ArchCard
                label="One harness, swapped models"
                body="Recall Labs writes the prompt, the rebalancing loop and the execution, then swaps the model behind it. That is what makes the roster comparable and also what limits it: this measures one harness interacting with each model, never a model's trading ability in the abstract."
              />
              <ArchCard
                label="Numbers or a picture"
                body="Most models are entered twice, once fed the chart as numeric series and once fed it as an image. Only three models currently have both variants, so the contrast is indicative rather than a result: the mean paired difference is 7.3 points with a standard deviation of 7.1."
              />
            </div>
          </section>

          <section className="mb-10">
            <h2 className="display text-xl sm:text-2xl text-ink mb-3">
              Why one arena and not a pooled leaderboard
            </h2>
            <div className="rounded-xl border border-ink/10 card-soft p-5 sm:p-6 text-sm text-ink-soft leading-relaxed max-w-3xl">
              <p>
                Recall runs several arenas, and pooling them is the obvious way
                to build a bigger table. We tried: eight defensible aggregates
                of the pooled data, and they disagree. Mean rank percentile
                against mean raw return share only 3 of the top 10 names, with
                a median move of 12 places and a maximum of 51 out of 67
                agents. Whatever sat on top would be a property of the chosen
                normalisation rather than of the agents.
              </p>
              <p className="mt-3">
                The arenas are not comparable on their face either. Round
                length spans 11x, funded capital spans ten orders of magnitude,
                field size runs from 6 to 64, and the instrument changes
                between spot, leveraged perpetuals and simulated money. So this
                page ranks one arena, names it, and leaves the rest out until
                each can carry its own page.
              </p>
              <p className="mt-3">
                One result from outside it is worth keeping in view. In a
                separate Recall round that put these same models against
                purpose-built trading agents on Hyperliquid perpetuals, the
                purpose-built entries took the first three places and every
                model trailed. The spread between models is much smaller than
                the spread between the agents that wrap them.
              </p>
            </div>
          </section>

          <AnswersForBench
            benchSlugs={["trading-agent-alpha"]}
            heading="Questions this benchmark answers"
          />
        </>
      ) : (
        <section className="rounded-xl border border-ink/10 card-soft p-6 sm:p-8">
          <p className="label-mono text-[10px] text-ink-faint mb-2">
            Data warming up
          </p>
          <p className="text-sm text-ink-soft max-w-2xl leading-relaxed">
            The snapshot has not been published yet. The bench page is already
            live:
          </p>
          <ul className="mt-4 flex flex-wrap gap-2 text-[12.5px]">
            <li>
              <Link
                href="/benchmarks/trading-agent-alpha"
                className="inline-flex rounded-full border border-ink/15 px-3 py-1 text-ink-soft hover:text-ink hover:border-ink/30"
              >
                trading-agent-alpha
              </Link>
            </li>
          </ul>
        </section>
      )}

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <p className="label-mono text-ink-faint mb-2">Methodology</p>
        <p>
          Source: Recall Labs&rsquo; public competition API, no credential
          required, recomputed from scratch once an hour. Scope: the{" "}
          <code>aerodrome-spot-live</code> arena, which is live spot trading on
          Base through Aerodrome with real money. Alpha is an agent&rsquo;s
          compounded return over its funded rounds minus the compounded return
          of a passive position at its own regression beta to ETH over exactly
          those rounds, so no agent is charged for a round it sat out or
          credited for the asset rising. Beta is measured per agent, not
          assumed, and the measured values run from 0.12 to 0.74. The asset
          counterfactual comes from Coinbase&rsquo;s public ETH-USD daily
          closes, deliberately outside Recall, because a benchmark drawn from
          the same source as the thing it measures is circular. Rounds whose
          whole field reports a zero portfolio are refused rather than scored
          as flat, and the refused count is published. Rounds are weekly and
          last six days, so a figure that has not moved in days is current
          rather than stale.
        </p>
        <p className="mt-3">
          Data and methodology released under{" "}
          <Link
            href="https://creativecommons.org/licenses/by/4.0/"
            className="underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            CC BY 4.0
          </Link>
          . Reuse with attribution to OpenChainBench.
        </p>
      </footer>
    </article>
  );
}

function LabGroup({
  lab,
}: {
  lab: { slug: string; name: string; model: string; agents: AgentRow[] };
}) {
  return (
    <>
      <tr className="border-b border-ink/10 bg-ink/[0.02]">
        <td className="py-2.5 pr-3" colSpan={7}>
          <div className="flex items-center gap-2">
            <ProviderLogo slug={lab.slug} name={lab.name} size={20} />
            <Link
              href={`/products/${lab.slug}`}
              className="font-semibold text-ink hover:underline underline-offset-2"
            >
              {lab.name}
            </Link>
            <span className="text-[11px] text-ink-muted">{lab.model}</span>
          </div>
        </td>
      </tr>
      {lab.agents.map((a) => (
        <tr key={a.slug} className="border-b border-ink/10">
          <td className="py-2.5 pr-3 pl-7">
            <span className="text-ink-soft">{a.name}</span>
            <span className="ml-2 inline-flex items-center rounded-full border border-ink/15 px-1.5 py-0.5 text-[10px] text-ink-muted">
              {a.modality === "vision" ? "fed an image" : "fed numbers"}
            </span>
          </td>
          <Td value={a.alpha} fmt={fmtPct} strong />
          <Td value={a.ret} fmt={fmtPct} />
          <Td value={a.passive} fmt={fmtPct} />
          <Td value={a.hitRate} fmt={fmtPct0} />
          <Td value={a.beta} fmt={fmtX} />
          <Td value={a.rounds} fmt={fmtInt} />
        </tr>
      ))}
    </>
  );
}

function Th({
  children,
  align = "left",
  className = "",
  tip,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  tip?: string;
}) {
  return (
    <th
      scope="col"
      title={tip}
      className={`py-2 pr-3 font-sans text-[11px] uppercase tracking-[0.14em] text-ink-muted font-medium ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  value,
  fmt,
  strong,
}: {
  value: number | null;
  fmt: (v: number) => string;
  strong?: boolean;
}) {
  return (
    <td
      className={`py-2.5 pr-3 text-right tabular-nums ${
        strong ? "font-semibold text-ink" : "text-ink-soft"
      }`}
    >
      {value == null ? <span className="text-ink-faint">&mdash;</span> : fmt(value)}
    </td>
  );
}

function SummaryCard({
  label,
  value,
  accent,
  tip,
}: {
  label: string;
  value: string;
  accent?: string;
  tip?: string;
}) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15"
      title={tip}
    >
      <p
        className="label-mono text-[10px] text-ink-faint mb-1 flex items-center gap-1.5"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {accent && (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: accent }}
          />
        )}
        {label}
      </p>
      <p className="text-base sm:text-xl font-semibold tabular-nums leading-tight">
        {value}
      </p>
    </div>
  );
}

function ArchCard({ label, body }: { label: string; body: string }) {
  return (
    <div className="card-soft rounded-xl border border-ink/10 p-4 sm:p-5">
      <p className="font-semibold text-ink mb-2">{label}</p>
      <p className="text-sm text-ink-soft leading-relaxed">{body}</p>
    </div>
  );
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return "...";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPct0(v: number): string {
  if (!Number.isFinite(v)) return "...";
  return `${Math.round(v)}%`;
}

function fmtX(v: number): string {
  if (!Number.isFinite(v)) return "...";
  return v.toFixed(2);
}

function fmtInt(v: number): string {
  if (!Number.isFinite(v)) return "...";
  return String(Math.round(v));
}
