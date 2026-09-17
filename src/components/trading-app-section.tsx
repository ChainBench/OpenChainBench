import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import {
  loadTradingAppMatrix,
  TRADING_APP_COLUMNS,
  TRADING_APP_SLUGS,
} from "@/lib/trading-apps";
import { TradingAppVolumeSection } from "@/components/trading-app-volume-section";
import { getTradingAppHistory } from "@/lib/trading-app-history";

/**
 * "Trading app" view on /products/<slug>, behind the pill bar. Mirrors
 * one row of the /trading-apps matrix for this platform: the six KPIs
 * (swap tx, average trade, active wallets, fee rate, app
 * rating) with the platform's rank among the cohort on each, then the
 * cohort table so the reader sees where it sits.
 *
 * Server component reading the same bench blobs the hub reads. Returns
 * null for slugs outside the cohort or with no figure at all.
 */
export async function TradingAppSection({
  slug,
  name,
}: {
  slug: string;
  name: string;
}) {
  const [matrix, history] = await Promise.all([loadTradingAppMatrix(), getTradingAppHistory()]);
  const inVolumeCohort = !!history?.apps.some((a) => a.slug === slug);
  const me = TRADING_APP_SLUGS.has(slug) ? matrix.rows.find((r) => r.slug === slug) : undefined;
  const hasDune = !!me && TRADING_APP_COLUMNS.some((c) => me.values[c.key] !== null);
  if (!inVolumeCohort && !hasDune) return null;

  return (
    <section id="trading-app" className="scroll-mt-24 py-10 border-t border-ink/8 first:border-0">
      <header className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-2xl sm:text-3xl font-semibold display tracking-tight">{name}</h2>
          <span
            className="label-mono text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md border border-ink/15 text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Trading app
          </span>
        </div>
        <Link href="/trading-apps" className="text-sm text-ink-faint hover:text-ink underline underline-offset-2">
          All trading apps
        </Link>
      </header>

      {inVolumeCohort && (
        <div className="mb-10">
          <p
            className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Cross-chain daily volume · bench 267
          </p>
          <TradingAppVolumeSection focus={slug} compact />
        </div>
      )}

      {hasDune && me && (
      <>
      <p
        className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-3"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        On-chain activity · Dune dataset
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {TRADING_APP_COLUMNS.map((col) => {
          const v = me.values[col.key];
          const r = me.ranks[col.key];
          const isBest = v !== null && matrix.bests[col.key] === v;
          return (
            <div
              key={col.key}
              className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
              style={{ minHeight: 96 }}
              title={me.formulas[col.key] ?? col.tip}
            >
              <p
                className="text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                {col.label}
                {me.scopes[col.key] && (
                  <span className="ml-1.5 normal-case tracking-normal text-ink-muted">· {me.scopes[col.key]}</span>
                )}
              </p>
              <p
                className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight"
                style={{ color: isBest ? "var(--color-good)" : undefined }}
              >
                {col.fmt(v)}
              </p>
              <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                {r ? (
                  <>
                    Rank {r.rank} of {r.of}
                  </>
                ) : (
                  "not measured"
                )}
              </p>
            </div>
          );
        })}
      </div>

      <p
        className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-3"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        Cohort · sorted by swap transactions
      </p>
      <div className="overflow-x-auto border-y border-rule">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left">
              <th className="py-2 pr-3 text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium">Platform</th>
              {TRADING_APP_COLUMNS.map((c) => (
                <th key={c.key} className="py-2 px-3 text-right text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium whitespace-nowrap" title={c.tip}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {matrix.rows.map((row) => {
              const mine = row.slug === slug;
              return (
                <tr key={row.slug} className={mine ? "bg-paper-soft/70" : "hover:bg-paper-soft/40 transition-colors"}>
                  <td className="py-2.5 pr-3">
                    {mine ? (
                      <span className="inline-flex items-center gap-2 font-semibold text-ink">
                        <ProviderLogo slug={row.slug} name={row.name} size={18} />
                        {row.name}
                      </span>
                    ) : (
                      <Link href={`/products/${row.slug}#trading-app`} className="inline-flex items-center gap-2 group">
                        <ProviderLogo slug={row.slug} name={row.name} size={18} />
                        <span className="font-medium text-ink group-hover:underline underline-offset-2">{row.name}</span>
                      </Link>
                    )}
                  </td>
                  {TRADING_APP_COLUMNS.map((c) => {
                    const v = row.values[c.key];
                    const best = v !== null && matrix.bests[c.key] === v;
                    const scope = row.scopes[c.key];
                    return (
                      <td
                        key={c.key}
                        className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap"
                        style={{ color: best ? "var(--color-good)" : v === null ? "var(--color-ink-faint)" : undefined }}
                        title={row.formulas[c.key] ?? undefined}
                      >
                        {c.fmt(v)}
                        {v !== null && scope === "Solana only" && (
                          <span className="ml-1 text-[9px] uppercase tracking-[0.12em] text-ink-faint" title="Solana only">SOL</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {matrix.updatedAt && (
        <p className="mt-3 text-[11px] text-ink-faint">
          Dune figures as of {new Date(matrix.updatedAt).toUTCString().replace("GMT", "UTC")}. Scope differs per
          platform: cross-chain where the Dune dataset covers every chain the platform runs on, <span className="uppercase tracking-[0.12em]">SOL</span> where it covers Solana only (hover a figure for the exact source). Each column links to its
          benchmark on{" "}
          <Link href="/trading-apps" className="underline hover:no-underline">
            /trading-apps
          </Link>
          .
        </p>
      )}
      </>
      )}
    </section>
  );
}
