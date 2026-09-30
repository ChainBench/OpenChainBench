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
 *   1. KPIs: cheapest terminal, spread, share of failed swaps, sample
 *      (or, on a product page, the terminal's own cost, rank, split, fails)
 *   2. the table: cost per swap (median with its 95 % interval, p90) with
 *      a stacked cost bar (terminal / network / other / pool), failed
 *      swaps, median trade, sample size
 *   3. the explorable table of sampled swaps (QA), method footer
 *
 * A terminal is published from `minPriced` priced swaps and ranked from
 * `minRank` (both in the JSON): between the two it is listed with its
 * figure but no rank. Server component reading the harness JSON (5 min
 * revalidate). Returns null when the JSON is unavailable so neither page
 * breaks.
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
  const ordered = rankTerminals(f);
  const ranked = ordered.filter((t) => t.ranked && t.loss);
  const published = ordered.filter((t) => t.healthy && t.loss);
  const me = focus ? f.terminals.find((t) => t.slug === focus) : null;
  if (focus && !me) return null;
  const meRank = me && me.ranked && me.loss ? ranked.findIndex((t) => t.slug === me.slug) + 1 : null;
  const top = ordered.slice(0, 8);
  const rows = compact ? (me && !top.some((t) => t.slug === me.slug) ? [...top, me] : top) : ordered;
  const cheapest = ranked[0];
  const priciest = ranked[ranked.length - 1];
  const totalPriced = f.terminals.reduce((s, t) => s + t.priced, 0);

  return (
    <div>
      {me ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <Kpi
            label="Cost per swap, median"
            value={me.healthy ? fmtBps(me.loss?.median) : "—"}
            sub={
              meRank
                ? `Rank ${meRank} of ${ranked.length} · ${ciText(me)}`
                : me.healthy && me.loss
                  ? `${ciText(me)} · ranked from ${f.minRank} swaps`
                  : me.priced > 0
                    ? whyUnpublished(me, f.minPriced)
                    : "no priced swap yet"
            }
          />
          <Kpi label="Terminal fee" value={me.healthy ? fmtBps(me.components.terminal) : "—"} sub={me.healthy ? (me.components.network !== undefined ? `network ${fmtBps(me.components.network)}` : undefined) : "published with the headline"} />
          <Kpi label="Failed swaps" value={me.healthy && me.failRatePct !== undefined ? `${me.failRatePct.toFixed(1)}%` : "—"} sub={me.healthy ? failSub(me) : "published with the headline"} />
          <Kpi label="Swaps sampled" value={me.priced.toLocaleString("en-US")} sub={`${me.parsed} read · p90 ${me.healthy ? fmtBps(me.loss?.p90) : "—"}`} />
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <Kpi label="Cheapest fill, median" value={cheapest?.name ?? "—"} sub={cheapest ? `${fmtBps(cheapest.loss?.median)} per swap · ${ciText(cheapest)}` : `no terminal at ${f.minRank} swaps yet`} logo={cheapest?.slug} />
          <Kpi label="Most expensive, median" value={priciest && priciest !== cheapest ? priciest.name : "—"} sub={priciest && priciest !== cheapest ? `${fmtBps(priciest.loss?.median)} per swap · ${ciText(priciest)}` : undefined} logo={priciest && priciest !== cheapest ? priciest.slug : undefined} />
          <Kpi label="Failed swaps" value={aggregateFail(f.terminals)} sub="all terminals, share of swap attempts" />
          <Kpi label="Swaps sampled" value={totalPriced.toLocaleString("en-US")} sub={`${ranked.length} ranked · ${published.length} published of ${ordered.length}`} />
        </div>
      )}

      <div className="overflow-x-auto border-y border-rule mb-4">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left">
              <Th>Terminal</Th>
              <Th right title="Median sampled swap size, dollars">Median swap</Th>
              <Th right title="Median value lost per swap against the pool's state before the trade, all costs included, basis points of the trade (100 bps = 1 %), with the 95 % interval of the median under it. Two rows whose intervals overlap are not separated by this measurement; most adjacent pairs on this board overlap, so read the ranking as a few groups rather than a strict order.">Value lost, median</Th>
              <Th right title="Median loss applied to the median trade: what the typical swap on this terminal loses, in dollars">Lost / swap, median</Th>
              <Th right title="What the app itself took, basis points of the trade (median): its fee wallets and fee legs on Solana, the router's residual after the pool and the gas on the EVM rows (referral transfers included), the app fee on Relay legs; referral or cashback legs count as terminal fee where the terminal's list holds them, else they sit in Protocol">App fee</Th>
              <Th right title="Transaction fee paid by the user plus inclusion tips (Jito and the terminal's own relay) plus the deposit of the token accounts the swap creates, and on cross-chain rows the destination gas Relay charged, basis points (median per chain; flow-weighted on All chains)">Network</Th>
              <Th right title="The final pool's LP fee and price impact, basis points (median per chain; on All chains each chain's median weighted by its flow); on cross-chain products the bridge's take is shown next to it as relay; on the EVM rows the stable-to-gas-coin hop's own cost is included (the native leg is valued at that hop's pre-trade mid)">Pool</Th>
              <Th right title="What the protocol took: launchpad and curve fees (pump.fun, the EVM launchpads: 1 % + a creator fee set per token), referral payouts, and on routed swaps the routers' cuts and hop leftovers, basis points (median per chain; flow-weighted on All chains)">Protocol</Th>
              <Th right title="Share of the terminal's swap attempts that failed on-chain; the priority fee is paid anyway unless the app sponsors gas (FOMO)">Failed</Th>
              <Th right title="90th percentile of the value lost">p90</Th>
              <Th right title="Priced swaps in the window">Swaps</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((t) => {
              const mine = focus === t.slug;
              const rank = ranked.findIndex((p) => p.slug === t.slug) + 1;
              const pub = t.healthy && !!t.loss;
              return (
                <tr key={t.slug} className={mine ? "bg-paper-soft/70" : "hover:bg-paper-soft/40 transition-colors"}>
                  <td className="py-2.5 pr-3 whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-5 text-right text-ink-faint tabular-nums text-[11px]" title={pub && !rank ? `published, ranked from ${f.minRank} priced swaps` : undefined}>
                        {rank ? rank : "·"}
                      </span>
                      {mine ? (
                        <span className="inline-flex items-center gap-2 font-semibold text-ink">
                          <ProviderLogo slug={t.slug} name={t.name} size={18} />
                          {t.name}
                        </span>
                      ) : (
                        <Link href={`/products/${t.product || productOf(t.slug)}#trading-app`} className="inline-flex items-center gap-2 group">
                          <ProviderLogo slug={t.product || productOf(t.slug)} name={t.name} size={18} />
                          <span className="font-medium text-ink group-hover:underline underline-offset-2">{t.name}</span>
                        </Link>
                      )}
                      {isXchain(t.slug) || !t.name.toLowerCase().endsWith(t.kind) ? (
                        <span className="text-[9px] uppercase tracking-[0.12em] text-ink-faint">{isXchain(t.slug) ? xchainLabel(t.slug) : t.kind}</span>
                      ) : null}
                      {Object.keys(t.byChain).length > 1 ? (
                        <span className="text-[9px] uppercase tracking-[0.12em] text-ink-faint border border-rule rounded px-1 cursor-help" title={chainText(t)}>
                          by chain
                        </span>
                      ) : null}
                      {pub && !rank ? <span className="text-[9px] uppercase tracking-[0.12em] text-ink-faint border border-rule rounded px-1">provisional</span> : null}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-soft">{t.tradeUsd ? fmtUsd(t.tradeUsd.median) : "—"}</td>
                  {/* The interval sits in the row, not in a tooltip. Only 3 of
                      12 adjacent pairs on this board are separable at 95%: two
                      rows whose intervals overlap are a coin flip, and a reader
                      who cannot see that reads a fourteen-place ranking into
                      what is really four groups. It was measured and formatted
                      all along, just hidden on hover. */}
                  <td className="py-2.5 px-3 text-right tabular-nums font-medium" title={pub ? `${fmtPct(t.loss!.median)} · ${ciText(t)}` : undefined}>
                    {pub ? (
                      <>
                        {fmtBps(t.loss!.median)} <span className="text-[10px] font-normal text-ink-faint">{fmtPct(t.loss!.median)}</span>
                        {t.loss!.ciLo !== undefined && t.loss!.ciHi !== undefined ? (
                          <span className="block text-[10px] font-normal text-ink-faint tabular-nums">
                            {Math.round(t.loss!.ciLo)}–{Math.round(t.loss!.ciHi)}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-ink-faint" title={t.priced > 0 ? whyUnpublished(t, f.minPriced) : "no priced swap yet"}>—</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums">{pub && t.tradeUsd && t.loss ? fmtUsd((t.tradeUsd.median * t.loss.median) / 1e4) : "—"}</td>
                  <SplitCell t={t} part="terminal" pub={pub} />
                  <SplitCell t={t} part="network" pub={pub} />
                  <SplitCell t={t} part="pool" pub={pub} relay />
                  <SplitCell t={t} part="other" pub={pub} />
                  <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: t.failRatePct !== undefined && t.failRatePct >= 5 ? "var(--color-bad, #e5484d)" : undefined }} title={t.failRatePct !== undefined ? `${t.attemptsFailed.toLocaleString("en-US")} of ${t.attempts.toLocaleString("en-US")} attempts${t.product !== "fomo" && Object.keys(t.byChain).some((c) => ["bnb", "robinhood", "base", "ethereum"].includes(c)) ? " (EVM rows estimated from sampled blocks)" : ""} · ${failSub(t)}` : undefined}>
                    {t.failRatePct !== undefined ? `${t.failRatePct.toFixed(1)}%` : "—"}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-soft">{pub ? fmtBps(t.loss!.p90) : "—"}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-soft">{t.priced}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mb-6 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-soft">
        <span className="text-ink-faint">Every figure here is a median, not an average: losses have a long right tail, so averaging the sampled rows returns a larger number (pump.fun, 250 bps median against a 360 bps mean). Split columns are medians of each cost in basis points of the trade (100 bps = 1 %), each chain&apos;s median weighted by its flow on a multi-chain product; they do not sum to the median loss, the per-swap sums do (audit table).</span>
        {PARTS.map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS[c] }} />
            {LABELS[c]}
          </span>
        ))}
      </p>

      {me && Object.keys(me.bySize).length > 0 && (
        <div className="mb-6">
          <p className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-2" style={{ fontFamily: "var(--font-mono, monospace)" }}>
            Cost per swap by trade size, median · {me.name}
          </p>
          <div className="grid grid-cols-3 gap-3 max-w-xl">
            {(["under25", "25to250", "over250"] as const).map((b) => {
              const q = me.bySize[b];
              const cohort = sizeCohortMedian(f.terminals, b);
              return (
                <div key={b} className="card-soft rounded-lg p-3 border border-ink/15">
                  <p className="text-[10px] text-ink-faint uppercase tracking-wide" style={{ fontFamily: "var(--font-mono, monospace)" }}>{SIZE_LABELS[b]}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{q ? fmtBps(q.median) : "—"}</p>
                  <p className="text-[10px] text-ink-faint uppercase tracking-[0.14em]">{q ? `${q.n} swaps${cohort !== undefined ? ` · cohort ${fmtBps(cohort)}` : ""}` : "under 5 swaps"}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="mb-6 text-[12px]">
        <Link href="/benchmarks/terminal-fill-quality#swaps" className="underline underline-offset-2 hover:no-underline font-medium">
          Audit the sampled swaps
        </Link>
        <span className="text-ink-faint"> · the {f.recent.length} most recent transactions{focus ? ` (${f.recent.filter((s) => s.terminal === focus).length} on ${me?.name})` : ""}, one per row with its Solscan link, loss and cost split, on the bench page</span>
      </p>

      <p className="text-[11px] text-ink-faint leading-relaxed max-w-3xl">
        Real user swaps read on-chain (Solana: each terminal&apos;s fee-wallet and program feed; EVM: the terminals&apos; routers and blocks read in full; 400 drawn at random per terminal per day, 1,000 on the EVM rows, every attempt
        counted for the fail rate), valued at the pool&apos;s state before the trade (exact where the pool&apos;s formula is known: PumpSwap, Raydium, Launchpad, DLMM, four.meme, the EVM pools;
        the previous trade on the same pool within 60 s elsewhere; swaps without one keep their cost split but no loss figure).
        Loss = 1 − value received / value given, in basis points of the trade; terminal, network and other are exact from balance deltas, the tx fee
        and inclusion tips included. Published from {f.minPriced} priced swaps pooled (a chain row or a single-chain product from {Math.max(20, Math.floor(f.minPriced / 2))}), ranked from {f.minRank}.
        {me?.note ? <span className="text-ink-soft"> {me.note}</span> : null} Bench{" "}
        <Link href="/benchmarks/terminal-fill-quality" className="underline hover:no-underline">
          268
        </Link>
        , rolling {f.windowHours} h, as of {f.generatedAt ? new Date(f.generatedAt).toUTCString().replace("GMT", "UTC") : "—"}.
      </p>
    </div>
  );
}

const COLORS = { terminal: "#FF6B35", network: "#FFC857", relay: "#2DD4BF", other: "#8B5CF6", pool: "#5B89FF" } as const;
const LABELS = { terminal: "Terminal fee", network: "Network (tx fee + tips, origin gas)", relay: "Relay (bridge fees + spread)", other: "Protocol fees (launchpad, curve, referrals)", pool: "Pool (LP fee + impact, hops)" } as const;
const PARTS = ["terminal", "network", "relay", "other", "pool"] as const;
const CHAIN_NAMES: Record<string, string> = { bnb: "BNB", robinhood: "Robinhood Chain", base: "Base", ethereum: "Ethereum", arc: "Arc", hyperevm: "HyperEVM", solana: "Solana" };

const XCHAIN_SUFFIX = /-(funding|bnb|robinhood|base|ethereum|arc|hyperevm)$/;
/** Cross-chain rows (funding leg, or trading on another chain through Relay) belong to the product of the native slug. */
function productOf(slug: string): string {
  return slug.replace(XCHAIN_SUFFIX, "");
}
function isXchain(slug: string): boolean {
  return XCHAIN_SUFFIX.test(slug);
}
function xchainLabel(slug: string): string {
  const m = slug.match(XCHAIN_SUFFIX);
  if (!m) return "";
  if (m[1] === "funding") return "funding leg";
  const viaRelay = slug.startsWith("fomo-") || slug.startsWith("pump-fun-") || slug.startsWith("phantom-"); // BasedBot's chain rows are native swaps on its router
  return `on ${CHAIN_NAMES[m[1]] ?? m[1]}${viaRelay ? " via Relay" : ""}`;
}
function chainText(t: TerminalFillStats): string {
  return Object.entries(t.byChain)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([c, q]) => `${CHAIN_NAMES[c] ?? c} ${Math.round(q.median)} bps (${q.n})`)
    .join(" · ");
}

/** "95 % interval 210 to 260 bps · n swaps" for a published terminal. */
function ciText(t: TerminalFillStats): string {
  const l = t.loss;
  if (!l) return "";
  if (l.ciLo === undefined || l.ciHi === undefined) return `${l.n} swaps`;
  return `95 % interval ${Math.round(l.ciLo)} to ${Math.round(l.ciHi)} bps · ${l.n} swaps`;
}

/** "mostly slippage · $0.01 per failed attempt · burns 3.2 bps per swap" */
function failSub(t: TerminalFillStats): string {
  const parts: string[] = [];
  const r = topReason(t);
  if (r) parts.push(`mostly ${r}`);
  if (t.failCostUsd) parts.push(`$${t.failCostUsd.median.toFixed(t.failCostUsd.median < 0.1 ? 3 : 2)} per failed attempt`);
  if (t.failOverheadBps !== undefined) parts.push(`burns ${fmtBps(t.failOverheadBps)} per swap`);
  if (parts.length === 0) parts.push(`${t.attempts.toLocaleString("en-US")} attempts seen`);
  return parts.join(" · ");
}

/** Most frequent failure class, in plain words where known. */
function topReason(t: TerminalFillStats): string | undefined {
  const e = Object.entries(t.failReasons).sort((a, b) => b[1] - a[1])[0];
  if (!e) return undefined;
  const k = e[0];
  if (/^custom:(6001|6002|6003)$/i.test(k)) return "slippage";
  if (/SlippageTolerance/i.test(k)) return "slippage";
  if (/InsufficientFunds/i.test(k)) return "insufficient funds";
  return k.replace(/^custom:/, "program error ");
}

/** Stacked bar of the median cost components, on a shared scale. */
/** Why an entry is not published: the harness's own reason when it holds one, else the count. */
function whyUnpublished(t: TerminalFillStats, minPriced: number): string {
  const n = t.note ?? "";
  if (n.includes("still filling its window: the pooled figure waits")) return `${t.priced} priced swaps, but the chain carrying most of the flow is still filling: the pooled figure waits for it`;
  if (n.includes("One side only in the sample")) return `${t.priced} priced swaps, one side only with no fee on it: the fee is taken on the side the feed never sees`;
  if (n.includes("No chain row of this product is published on its own yet")) return `${t.priced} priced swaps, but no chain of this product is published on its own yet: the pooled figure waits`;
  if (n.includes("Re-sampling")) return `${t.priced} priced swaps: re-sampling after a method change, the figure returns when the window refills (${minPriced} needed)`;
  return `${t.priced} priced swaps, ${minPriced} needed`;
}

/** Percent of the trade from basis points: 442 bps → "4.42 %". */
function fmtPct(bps: number): string {
  const sign = bps < 0 ? "−" : "";
  return `${sign}${(Math.abs(bps) / 100).toFixed(2)} %`;
}

/** One numeric cell of the median cost split, in basis points, tinted like the bar. On a cross-chain product the pool cell carries the relay's take next to it. */
function SplitCell({ t, part, pub, relay = false }: { t: TerminalFillStats; part: (typeof PARTS)[number]; pub: boolean; relay?: boolean }) {
  const v = t.components[part];
  const r = relay ? t.components.relay : undefined;
  return (
    <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap" style={{ color: pub && v !== undefined ? COLORS[part] : undefined }} title={pub && v !== undefined ? `${LABELS[part]}: ${fmtBps(v)}${r !== undefined ? ` · relay ${fmtBps(r)}` : ""}` : undefined}>
      {pub && v !== undefined ? Math.round(v) : <span className="text-ink-faint">—</span>}
      {pub && r !== undefined && r >= 0.5 ? <span className="text-ink-faint text-[10px]"> +{Math.round(r)} relay</span> : null}
    </td>
  );
}

const SIZE_LABELS = { under25: "Under $25", "25to250": "$25 to $250", over250: "Over $250" } as const;

/** Median of the terminals' medians for a size bucket, as a cohort yardstick. */
function sizeCohortMedian(ts: TerminalFillStats[], b: keyof typeof SIZE_LABELS): number | undefined {
  const v = ts.map((t) => t.bySize[b]?.median).filter((x): x is number => x !== undefined).sort((a, c) => a - c);
  if (v.length === 0) return undefined;
  return v[Math.floor(v.length / 2)];
}

function aggregateFail(ts: TerminalFillStats[]): string {
  const seen = ts.reduce((s, t) => s + t.attempts, 0);
  const failed = ts.reduce((s, t) => s + t.attemptsFailed, 0);
  return seen > 0 ? `${((100 * failed) / seen).toFixed(1)}%` : "—";
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
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 10) return `$${v.toFixed(1)}`;
  return `$${v.toFixed(2)}`;
}
