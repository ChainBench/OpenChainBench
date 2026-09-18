import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import {
  fmtBps,
  getTerminalFills,
  rankTerminals,
  type TerminalFillStats,
} from "@/lib/terminal-fills";

/**
 * Fill quality block (bench 268) shared by the /trading-apps hub and the
 * "Trading app" view on /products/<slug>:
 *   1. KPIs: cheapest terminal, spread, share of failed transactions
 *      (or, on a product page, the terminal's own cost, rank, split, fails)
 *   2. the table: cost per swap (median, p90) with a stacked cost bar
 *      (terminal / network / other / pool), failed tx, median trade,
 *      sample size
 *   3. method footer
 *
 * Server component reading the harness JSON (5 min revalidate). Returns
 * null when the JSON is unavailable so neither page breaks.
 */
export async function TerminalFillSection({
  focus,
  compact = false,
}: {
  /** Product slug when rendered on a product page. */
  focus?: string;
  compact?: boolean;
}) {
  const f = await getTerminalFills();
  if (!f || f.terminals.length === 0) return null;
  const ranked = rankTerminals(f);
  const published = ranked.filter((t) => t.healthy && t.loss);
  const me = focus ? f.terminals.find((t) => t.slug === focus) : null;
  if (focus && !me) return null;
  const meRank = me && me.healthy && me.loss ? published.findIndex((t) => t.slug === me.slug) + 1 : null;
  const rows = compact ? ranked.slice(0, 8) : ranked;
  const maxBps = Math.max(1, ...ranked.map((t) => stackTotal(t)));
  const cheapest = published[0];
  const priciest = published[published.length - 1];

  return (
    <div>
      {me ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <Kpi
            label="Cost per swap, median"
            value={fmtBps(me.loss?.median)}
            sub={meRank ? `Rank ${meRank} of ${published.length} · p90 ${fmtBps(me.loss?.p90)}` : me.priced > 0 ? `${me.priced} swaps, not enough yet` : "no priced swap yet"}
          />
          <Kpi label="Terminal fee" value={fmtBps(me.components.terminal)} sub={me.components.network !== undefined ? `network ${fmtBps(me.components.network)}` : undefined} />
          <Kpi label="Pool + other fees" value={fmtBps(sum(me.components.pool, me.components.other))} sub={me.components.pool !== undefined ? `pool ${fmtBps(me.components.pool)}` : undefined} />
          <Kpi label="Failed transactions" value={me.failRatePct !== undefined ? `${me.failRatePct.toFixed(1)}%` : "—"} sub={`${me.seen.toLocaleString("en-US")} seen · ${me.priced} sampled`} />
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <Kpi label="Cheapest fill, median" value={cheapest?.name ?? "—"} sub={cheapest ? fmtBps(cheapest.loss?.median) + " per swap" : undefined} logo={cheapest?.slug} />
          <Kpi label="Most expensive, median" value={priciest && priciest !== cheapest ? priciest.name : "—"} sub={priciest && priciest !== cheapest ? fmtBps(priciest.loss?.median) + " per swap" : undefined} logo={priciest && priciest !== cheapest ? priciest.slug : undefined} />
          <Kpi label="Terminals published" value={`${published.length} of ${f.terminals.length}`} sub={`${f.terminals.reduce((s, t) => s + t.priced, 0).toLocaleString("en-US")} swaps in ${f.windowHours}h`} />
          <Kpi label="Failed transactions" value={aggregateFail(f.terminals)} sub="all terminals, share of routed tx" />
        </div>
      )}

      <div className="overflow-x-auto border-y border-rule mb-4">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left">
              <Th>Terminal</Th>
              <Th right title="Median value lost per swap against the pool's arrival price, all costs included, basis points of the trade">Cost per swap</Th>
              <Th right title="90th percentile of the same">p90</Th>
              <Th title="Median cost split: terminal fee, network (priority fee + Jito tip), other fees (pump.fun protocol and creator, referrals), pool (LP fee + price impact)">Where it goes</Th>
              <Th right title="Share of the terminal's transactions that failed on-chain; the priority fee is paid anyway">Failed tx</Th>
              <Th right title="Median sampled trade size">Median trade</Th>
              <Th right title="Priced swaps in the window">Swaps</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((t) => {
              const mine = focus === t.slug;
              const rank = published.findIndex((p) => p.slug === t.slug) + 1;
              const pub = t.healthy && !!t.loss;
              return (
                <tr key={t.slug} className={mine ? "bg-paper-soft/70" : "hover:bg-paper-soft/40 transition-colors"}>
                  <td className="py-2.5 pr-3 whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-5 text-right text-ink-faint tabular-nums text-[11px]">{pub ? rank : "·"}</span>
                      {mine ? (
                        <span className="inline-flex items-center gap-2 font-semibold text-ink">
                          <ProviderLogo slug={t.slug} name={t.name} size={18} />
                          {t.name}
                        </span>
                      ) : (
                        <Link href={`/products/${t.slug}#trading-app`} className="inline-flex items-center gap-2 group">
                          <ProviderLogo slug={t.slug} name={t.name} size={18} />
                          <span className="font-medium text-ink group-hover:underline underline-offset-2">{t.name}</span>
                        </Link>
                      )}
                      <span className="text-[9px] uppercase tracking-[0.12em] text-ink-faint">{t.kind}</span>
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums font-medium">
                    {pub ? fmtBps(t.loss!.median) : <span className="text-ink-faint" title={t.priced > 0 ? `${t.priced} priced swaps, 20 needed` : "no priced swap yet"}>—</span>}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-soft">{pub ? fmtBps(t.loss!.p90) : "—"}</td>
                  <td className="py-2.5 pr-4">
                    <CostBar t={t} max={maxBps} />
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: t.failRatePct !== undefined && t.failRatePct >= 5 ? "var(--color-bad, #e5484d)" : undefined }}>
                    {t.failRatePct !== undefined ? `${t.failRatePct.toFixed(1)}%` : "—"}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-soft">{t.tradeUsd ? fmtUsd(t.tradeUsd.median) : "—"}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-soft">{t.priced}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mb-6 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-soft">
        {(["terminal", "network", "other", "pool"] as const).map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS[c] }} />
            {LABELS[c]}
          </span>
        ))}
      </p>

      <p className="text-[11px] text-ink-faint leading-relaxed max-w-3xl">
        Real user swaps read on-chain from each terminal&apos;s fee-wallet transactions (newest first, 4 per terminal every 90 s),
        valued at the pool&apos;s pre-trade mid (exact from its reserves on PumpSwap and Raydium, the previous trade on the same pool
        elsewhere, Jupiter&apos;s price when neither is readable). Loss = 1 − value received /
        value given, in basis points of the trade; the split is exact from balance deltas. Sandwiches are not isolated yet.
        {me?.note ? <span className="text-ink-soft"> {me.note}</span> : null} Bench{" "}
        <Link href="/benchmarks/terminal-fill-quality" className="underline hover:no-underline">
          268
        </Link>
        , rolling {f.windowHours} h, as of {f.generatedAt ? new Date(f.generatedAt).toUTCString().replace("GMT", "UTC") : "—"}.
      </p>
    </div>
  );
}

const COLORS = { terminal: "#FF6B35", network: "#FFC857", other: "#8B5CF6", pool: "#5B89FF" } as const;
const LABELS = { terminal: "Terminal fee", network: "Network (priority + tip)", other: "Other fees (pump.fun, referrals)", pool: "Pool (LP fee + impact, hops)" } as const;

function stackTotal(t: TerminalFillStats): number {
  return (["terminal", "network", "other", "pool"] as const).reduce((s, c) => s + Math.max(0, t.components[c] ?? 0), 0);
}

/** Stacked bar of the median cost components, on a shared scale. */
function CostBar({ t, max }: { t: TerminalFillStats; max: number }) {
  const parts = (["terminal", "network", "other", "pool"] as const)
    .map((c) => ({ c, v: Math.max(0, t.components[c] ?? 0) }))
    .filter((p) => p.v > 0);
  if (parts.length === 0) return <span className="text-ink-faint">—</span>;
  const total = parts.reduce((s, p) => s + p.v, 0);
  const width = Math.max(4, Math.min(100, (total / max) * 100));
  const title = parts.map((p) => `${LABELS[p.c]}: ${fmtBps(p.v)}`).join("\n");
  return (
    <span className="inline-flex items-center gap-2.5 w-full min-w-[160px]" title={title}>
      <span className="flex h-2 overflow-hidden rounded-full bg-paper-soft" style={{ width: `${width}%`, minWidth: 12 }}>
        {parts.map((p) => (
          <span key={p.c} style={{ width: `${(p.v / total) * 100}%`, background: COLORS[p.c] }} />
        ))}
      </span>
      <span className="text-[11px] text-ink-soft whitespace-nowrap tabular-nums">
        {t.components.terminal !== undefined ? `fee ${Math.round(t.components.terminal)}` : ""}
        {t.components.network !== undefined ? ` · net ${Math.round(t.components.network)}` : ""}
        {t.components.pool !== undefined ? ` · pool ${Math.round(t.components.pool)}` : ""}
      </span>
    </span>
  );
}

function aggregateFail(ts: TerminalFillStats[]): string {
  const seen = ts.reduce((s, t) => s + t.seen, 0);
  const failed = ts.reduce((s, t) => s + t.failed, 0);
  return seen > 0 ? `${((100 * failed) / seen).toFixed(1)}%` : "—";
}

function sum(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function Kpi({ label, value, sub, logo }: { label: string; value: string; sub?: string; logo?: string }) {
  return (
    <div className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col" style={{ minHeight: 96 }}>
      <p className="text-[10px] text-ink-faint uppercase tracking-wide leading-snug" style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {label}
      </p>
      <p className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight inline-flex items-center gap-2">
        {logo ? <ProviderLogo slug={logo} name={value} size={20} /> : null}
        {value}
      </p>
      {sub && (
        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] truncate text-ink-faint" title={sub}>
          {sub}
        </p>
      )}
    </div>
  );
}

function Th({ children, right, title }: { children: React.ReactNode; right?: boolean; title?: string }) {
  return (
    <th
      className={`py-2 ${right ? "px-3 text-right" : "pr-3"} text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium whitespace-nowrap ${title ? "cursor-help" : ""}`}
      title={title}
    >
      {children}
    </th>
  );
}

function fmtUsd(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
