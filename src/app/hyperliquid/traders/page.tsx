import Link from "next/link";
import { fetchHlTraders } from "@/lib/hl-traders";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/jsonld";
import type { HlTraderRow, HlTradersSnapshot } from "@/types/hl-traders";

/**
 * Audit of Hyperliquid's own published trader leaderboard.
 *
 * Deliberately not a copy of that table. The venue renders it already,
 * and a reproduction would add nothing. What is missing is the reading
 * of it, because three published properties contradict each other and
 * the venue's UI offers no way to see it:
 *
 *   1. `pnl` and `vlm` sit in one row and count different universes.
 *      `vlm` is perp notional; `pnl` absorbs spot, vaults and staking.
 *      Thousands of rows therefore publish profit against zero volume.
 *   2. the aggregate is strongly positive. Perp PnL is zero-sum between
 *      longs and shorts net of fees, so a positive sum over a majority
 *      of winners is proof the published set is not the population.
 *   3. `roi` ships without its denominator, so it is not comparable
 *      across rows at any value.
 *
 * The table below is kept, capped and ranked, with the zero-volume rows
 * marked in place rather than filtered out: dropping them would publish
 * the flattering half of the fact.
 *
 * Data comes from the `hl-archive traders` collector through Upstash.
 * When no snapshot exists the page says so, because zeros would read as
 * a measurement.
 */

const DESCRIPTION =
  "Hyperliquid publishes a PnL leaderboard for tens of thousands of accounts. We audit it daily: profit on zero volume, ROI without a denominator, the perp split.";

export const metadata = pageMetadata({
  path: "/hyperliquid/traders",
  title: "Hyperliquid trader leaderboard, audited",
  description: DESCRIPTION,
});

/** The snapshot refreshes once a day; an hourly window keeps the page
 *  cheap while still picking up a late collector run. */
export const revalidate = 3600;

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  const neg = v < 0;
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e9) s = `$${(a / 1e9).toFixed(2)}B`;
  else if (a >= 1e6) s = `$${(a / 1e6).toFixed(1)}M`;
  else if (a >= 1e3) s = `$${(a / 1e3).toFixed(0)}K`;
  else s = `$${a.toFixed(0)}`;
  return neg ? `-${s}` : s;
}

function fmtInt(v: number): string {
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "n/a";
}

function fmtPct(v: number, digits = 1): string {
  return Number.isFinite(v) ? `${v.toFixed(digits)}%` : "n/a";
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export default async function HlTradersPage() {
  const read = await fetchHlTraders();

  return (
    <article className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-12">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "WebPage",
            name: "Hyperliquid trader leaderboard, audited",
            description: DESCRIPTION,
            url: "https://openchainbench.com/hyperliquid/traders",
            isPartOf: {
              "@type": "WebSite",
              name: "OpenChainBench",
              url: "https://openchainbench.com",
            },
          }),
        }}
      />

      <header className="pb-2">
        <p className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
          Hyperliquid
        </p>
        <h1 className="mt-2 display text-4xl sm:text-5xl tracking-tight text-ink">
          The leaderboard, audited
        </h1>
        <p className="mt-4 max-w-3xl text-base sm:text-lg text-ink-muted leading-snug">
          Hyperliquid publishes its own trader leaderboard as one public
          blob: every account, with PnL, ROI, volume and equity. We do not
          reproduce it. We read it, and three of its published properties
          contradict each other.
        </p>
      </header>

      {read === null ? (
        <EmptyState />
      ) : (
        <>
          {read.stale && (
            <p className="mt-8 card-soft rounded-xl px-5 py-4 text-sm text-ink-soft border-l-4 border-l-[var(--color-warn,#c08a3c)]">
              This reading is {Math.round(read.ageHours)} hours old. The
              collector runs daily, so the figures below describe the blob
              as it stood then, not as it stands now.
            </p>
          )}
          {read.snapshot.integrity.malformed_rows > 0 && (
            <p className="mt-4 card-soft rounded-xl px-5 py-4 text-sm text-ink-soft border-l-4 border-l-[var(--color-accent,#c97c5d)]">
              {fmtInt(read.snapshot.integrity.malformed_rows)} of{" "}
              {fmtInt(read.snapshot.integrity.accounts)} rows did not read
              cleanly on this run, which means the published blob&apos;s
              shape has moved. Treat every figure below as needing a
              re-read before it is quoted.
            </p>
          )}
          <Findings snap={read.snapshot} />
          <Table snap={read.snapshot} />
          <Methodology snap={read.snapshot} />
        </>
      )}

      <p className="mt-16 text-xs text-ink-muted">
        Builder revenue and HIP-3 dexes live on the{" "}
        <Link href="/hyperliquid" className="lnk text-ink-soft">
          Hyperliquid hub
        </Link>
        . How we measure in general is on{" "}
        <Link href="/methodology" className="lnk text-ink-soft">
          Methodology
        </Link>
        .
      </p>
    </article>
  );
}

function EmptyState() {
  return (
    <section className="mt-10 card-soft rounded-xl p-6 sm:p-8">
      <h2 className="display text-xl text-ink">Awaiting the first run</h2>
      <p className="mt-3 max-w-2xl text-sm text-ink-soft leading-relaxed">
        No audit snapshot has been published yet. The{" "}
        <code className="font-sans text-[13px] text-ink">
          hl-archive traders
        </code>{" "}
        collector writes one per day; until it has run once, this page has
        nothing measured to show. It deliberately shows nothing rather than
        zeros, because a zero here would read as a reading.
      </p>
    </section>
  );
}

function Findings({ snap }: { snap: HlTradersSnapshot }) {
  const { integrity: i, decomposition: d } = snap;
  const items = [
    {
      n: "I",
      color: "var(--color-accent, #c97c5d)",
      title: "Profit on no volume",
      body: `${fmtInt(i.zero_vlm_accounts)} of ${fmtInt(
        i.accounts,
      )} accounts publish a non-zero all-time PnL against exactly zero all-time volume, worth ${fmtUsd(
        i.zero_vlm_pnl_usd,
      )}. That is ${fmtPct(
        i.zero_vlm_pnl_pct,
      )} of the leaderboard's aggregate PnL. The two fields count different universes: volume is perp notional, PnL also absorbs spot, vault deposits and staking. They are published side by side, and the table sorts on them.`,
    },
    {
      n: "II",
      color: "var(--color-warn, #c08a3c)",
      title: "An aggregate that cannot be",
      body: `The published rows sum to ${fmtUsd(
        i.agg_pnl_usd,
      )} of all-time PnL, with ${fmtPct(
        i.winners_pct,
      )} of accounts in profit. Perp PnL is zero-sum between longs and shorts net of fees, so a positive aggregate over a majority of winners is arithmetic proof that the published set is not the population: the losers are not in it. Spot and HLP yield are genuinely not zero-sum and account for part of the surplus, which is the same finding seen from the other side.`,
    },
    {
      n: "III",
      color: "#7a6db8",
      title: "ROI without a denominator",
      body: `${fmtInt(
        i.roi_outliers,
      )} accounts publish an ROI above 10,000% in absolute value, the highest of them past 2,600,000% on five figures of volume. ROI ships with no stated base, so it is not comparable between rows at any value, large or small. It is presented as a sortable column.`,
    },
  ];

  return (
    <section className="mt-14">
      <SectionHeader number="I" label="What the blob says" />
      <ol className="mt-6 grid gap-4">
        {items.map((it) => (
          <li
            key={it.n}
            className="card-soft rounded-xl p-6 sm:p-7 relative overflow-hidden"
          >
            <span
              className="absolute left-0 top-0 bottom-0 w-[3px]"
              style={{ background: it.color }}
              aria-hidden
            />
            <p
              className="font-sans text-[11px] font-semibold uppercase tracking-[0.2em]"
              style={{ color: it.color }}
            >
              {it.n}
            </p>
            <h3 className="mt-2 display text-lg sm:text-xl text-ink leading-tight">
              {it.title}
            </h3>
            <p className="mt-2 text-sm text-ink-soft leading-relaxed">
              {it.body}
            </p>
          </li>
        ))}
      </ol>

      {d.sampled > 0 && (
        <div className="mt-4 card-soft rounded-xl p-6 sm:p-7">
          <h3 className="display text-lg text-ink">
            The split the leaderboard flattens
          </h3>
          <p className="mt-2 max-w-3xl text-sm text-ink-soft leading-relaxed">
            The info API publishes a perp-only mirror of every window, so
            the mix does not have to be inferred. Across the{" "}
            {fmtInt(d.sampled)} highest-PnL accounts,{" "}
            {fmtPct(d.non_perp_pnl_pct)} of lifetime PnL came from
            somewhere other than perps ({fmtUsd(d.non_perp_pnl_usd)} of{" "}
            {fmtUsd(d.pnl_usd)}), and {fmtInt(d.accounts_with_non_perp_pnl)}{" "}
            of them carry a non-perp component at all. Read that as a
            property of the rows the leaderboard showcases, never of the
            population: ranking by PnL selects for the zero-volume cohort
            by construction, which is why the sample size travels with the
            figure.
          </p>
        </div>
      )}
    </section>
  );
}

function Table({ snap }: { snap: HlTradersSnapshot }) {
  const rows = snap.top;
  if (rows.length === 0) return null;
  return (
    <section className="mt-16">
      <SectionHeader number="II" label="The top of the table, as published" />
      <p className="mt-4 max-w-3xl text-sm text-ink-soft leading-relaxed">
        The {fmtInt(rows.length)} highest rows of{" "}
        {fmtInt(snap.integrity.accounts)}, ordered by the venue&apos;s own
        all-time PnL. Rows claiming profit on zero volume are marked, not
        removed: filtering them would publish the flattering half of the
        fact.
      </p>
      <div className="mt-6 overflow-x-auto card-soft rounded-xl">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              {["#", "Account", "All-time PnL", "24h PnL", "Equity", "All-time volume"].map(
                (h) => (
                  <th
                    key={h}
                    className="font-sans text-[10px] uppercase tracking-[0.15em] text-ink-faint font-medium px-4 py-3 whitespace-nowrap"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((r, idx) => (
              <Row key={r.address} row={r} rank={idx + 1} />
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 100 && (
        <p className="mt-3 text-xs text-ink-muted">
          Showing the first 100 of {fmtInt(rows.length)} archived rows.
        </p>
      )}
    </section>
  );
}

function Row({ row, rank }: { row: HlTraderRow; rank: number }) {
  return (
    <tr className="border-t border-rule">
      <td className="px-4 py-2.5 font-sans tabular text-xs text-ink-faint">
        {rank}
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <span className="font-sans text-xs text-ink">
          {shortAddr(row.address)}
        </span>
        {row.no_volume && (
          <span
            className="ml-2 font-sans text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={{
              background: "var(--color-warn, #c08a3c)",
              color: "#fff",
            }}
            title="Publishes a non-zero PnL against zero all-time volume"
          >
            no volume
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 font-sans tabular text-ink whitespace-nowrap">
        {fmtUsd(row.pnl_usd)}
      </td>
      <td className="px-4 py-2.5 font-sans tabular text-ink-soft whitespace-nowrap">
        {fmtUsd(row.pnl_day_usd)}
      </td>
      <td className="px-4 py-2.5 font-sans tabular text-ink-soft whitespace-nowrap">
        {fmtUsd(row.equity_usd)}
      </td>
      <td className="px-4 py-2.5 font-sans tabular text-ink-soft whitespace-nowrap">
        {row.vlm_usd === 0 ? "—" : fmtUsd(row.vlm_usd)}
      </td>
    </tr>
  );
}

function Methodology({ snap }: { snap: HlTradersSnapshot }) {
  const items: [string, string][] = [
    [
      "Source",
      `One GET of ${snap.source}, the venue's own published blob. Public, no key, roughly 39 MB. Every aggregate on this page is a count or a sum over its rows, so anyone can recompute all of them from the same file.`,
    ],
    [
      "Perp split",
      "Per account, POST /info with {\"type\":\"portfolio\"} returns pnlHistory and accountValueHistory over day, week, month and allTime plus a perp-only mirror of each. The split is read from perpAllTime against allTime, not modelled.",
    ],
    [
      "Why no node",
      "Per-fill data for every account would need a Hyperliquid node; the public CDN serves builder_fills and nothing else. It is also unnecessary here, because per-account PnL is published directly and a node adds only trade-level detail this page does not use.",
    ],
    [
      "Zero-sum",
      "Perp PnL nets to zero between longs and shorts, minus fees, with funding a transfer between them. Spot holdings and HLP yield are not zero-sum, so they are the honest explanation for part of a positive aggregate, and the reason the perp split matters.",
    ],
    [
      "What we do not claim",
      "Nothing here says a figure is wrong. Each one is the venue's own. The finding is that fields counting different universes are published in one sortable row, and that the set is not the population.",
    ],
    [
      "Cadence",
      `Collected daily. This reading is from ${snap.updated_at}.`,
    ],
  ];
  return (
    <section className="mt-16">
      <SectionHeader number="III" label="How this is measured" />
      <dl className="mt-6 card-soft rounded-xl divide-y divide-rule overflow-hidden">
        {items.map(([term, body]) => (
          <div
            key={term}
            className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-1 sm:gap-8 py-4 px-5"
          >
            <dt className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink pt-1 font-medium">
              {term}
            </dt>
            <dd className="text-sm text-ink-soft leading-relaxed">{body}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SectionHeader({ number, label }: { number: string; label: string }) {
  return (
    <header className="flex items-baseline gap-3 border-b border-rule pb-2">
      <span className="font-sans text-[10px] uppercase tracking-[0.2em] text-ink-faint font-medium">
        Section {number}
      </span>
      <h2 className="display text-xl sm:text-2xl text-ink leading-none">
        {label}
      </h2>
    </header>
  );
}
