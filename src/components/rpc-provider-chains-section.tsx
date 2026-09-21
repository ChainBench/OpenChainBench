import Link from "next/link";
import { loadSitemapBlob } from "@/lib/sitemap-blob";
import { isExpiredRpcPage } from "@/lib/provider-filters";
import { fetchRpcHub } from "@/lib/rpc-hub-stats";
import { ProviderLogo } from "@/components/provider-logo";

/**
 * "RPC performance by chain" section for /products/<slug>. Renders only
 * for providers that appear in at least one chain of the rpc-hub cohort
 * snapshot (dRPC, PublicNode, Tenderly, 1RPC, ...): one row per covered
 * chain with rank, 24h p50 (3-region aggregate), success rate and the
 * derived failed-probe count — the same figures the /rpc pivot shows,
 * scoped to one provider.
 *
 * Server component, snapshot-only (fetchRpcHub reads the worker-written
 * cohort blob; zero Prometheus traffic). Rank is the row's index in the
 * chain's `providers[]` field, which rpc-hub-stats sorts fastest-first
 * over LIVE rows only — unresponsive providers are unranked there, same
 * convention as the bench-page ledger, and render here with a dashed
 * latency plus their still-recording success rate. Returns null when
 * the provider is absent from the snapshot, so non-RPC product pages
 * pay one cached read and render nothing.
 */

type Row = {
  chain: string;
  chainName: string;
  benchSlug: string;
  rank: number | null;
  totalRanked: number;
  p50Ms: number | null;
  successPct?: number;
  sampleSize?: number;
  /** "keyed" when the row comes from the API-key cohort (ranked among
   *  the keyed providers of that chain, linked to the keyed tab). */
  tier?: "keyed";
};

function errorCount(row: Row): number | null {
  if (row.sampleSize == null || row.successPct == null) return null;
  return Math.round(row.sampleSize * (1 - row.successPct / 100));
}

function fmtMs(v: number): string {
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

export async function RpcProviderChainsSection({
  providerSlug,
  providerName,
}: {
  providerSlug: string;
  providerName: string;
}) {
  const [snapshot, sitemapBlob] = await Promise.all([fetchRpcHub(), loadSitemapBlob()]);
  // Link a chain only when its bench page is indexable (worker sitemap
  // minus expired chain pages); thin or expired chains stay as text.
  const linkable = sitemapBlob
    ? new Set(sitemapBlob.benches.filter((b) => !isExpiredRpcPage(b)).map((b) => b.slug))
    : null;
  if (!snapshot) return null;

  const rows: Row[] = [];
  // Public cohort first, then the API-key cohort (Alchemy, Chainstack,
  // QuickNode): a provider sits in one of the two per chain, each ranked
  // on its own, so the rows never mix the two fields.
  const cohorts: Array<{ chains: typeof snapshot.chains; tier?: "keyed" }> = [
    { chains: snapshot.chains },
    ...(snapshot.keyed ? [{ chains: snapshot.keyed.chains, tier: "keyed" as const }] : []),
  ];
  for (const { chains, tier } of cohorts) {
    for (const c of chains) {
      const idx = c.providers.findIndex((p) => p.provider === providerSlug);
      if (idx >= 0) {
        const p = c.providers[idx];
        rows.push({
          chain: c.chain,
          chainName: c.name,
          benchSlug: c.slug,
          rank: idx + 1,
          totalRanked: c.providers.length,
          p50Ms: p.p50Ms,
          successPct: p.successPct,
          sampleSize: p.sampleSize,
          ...(tier ? { tier } : {}),
        });
        continue;
      }
      const dead = c.unresponsive?.find((u) => u.provider === providerSlug);
      if (dead) {
        rows.push({
          chain: c.chain,
          chainName: c.name,
          benchSlug: c.slug,
          rank: null,
          totalRanked: c.providers.length,
          p50Ms: null,
          successPct: dead.successPct,
          sampleSize: dead.sampleSize,
          ...(tier ? { tier } : {}),
        });
      }
    }
  }
  if (rows.length === 0) return null;
  const keyedOnly = rows.every((r) => r.tier === "keyed");
  const mixed = !keyedOnly && rows.some((r) => r.tier === "keyed");

  return (
    <section className="mt-12">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
        RPC performance by chain
      </h2>
      <p className="mt-2 text-sm text-ink-soft leading-snug max-w-2xl">
        {keyedOnly ? (
          <>
            Where {providerName}&apos;s API-key endpoint ranks among the keyed
            providers measured on each chain (Alchemy, Chainstack, QuickNode,
            probed every 120 s): 24h p50 across 3 probe regions, success rate
            and failed probes. Never ranked against the free public gateways.
          </>
        ) : (
          <>
            Where {providerName}&apos;s free endpoint ranks on each measured
            chain: 24h p50 across 3 probe regions, success rate and failed
            probes.
            {mixed ? " Rows marked API key are ranked within the keyed cohort of that chain, apart from the public gateways." : ""}
          </>
        )}{" "}
        Full field on{" "}
        <Link href="/rpc" className="lnk">
          /rpc
        </Link>
        .
      </p>
      <div className="mt-4 overflow-x-auto border-y border-rule">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule text-left">
              <Th className="pr-3">Chain</Th>
              <Th className="px-3 text-right">Rank</Th>
              <Th className="px-3 text-right">p50 (24h)</Th>
              <Th className="px-3 text-right">Success</Th>
              <Th className="pl-3 text-right">Errors (24h)</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((r) => (
              <tr key={`${r.chain}-${r.tier ?? "public"}`} className="hover:bg-paper-soft/60 transition-colors">
                <td className="py-2.5 pr-3">
                  {!linkable || linkable.has(r.benchSlug) ? (
                    <Link
                      href={`/benchmarks/${r.benchSlug}${r.tier ? `?tier=${r.tier}` : ""}`}
                      className="inline-flex items-center gap-2 group"
                    >
                      <ProviderLogo slug={r.chain} name={r.chainName} size={18} />
                      <span className="font-medium text-ink group-hover:underline underline-offset-2">
                        {r.chainName}
                      </span>
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <ProviderLogo slug={r.chain} name={r.chainName} size={18} />
                      <span className="font-medium text-ink">{r.chainName}</span>
                    </span>
                  )}
                  {r.tier === "keyed" && !keyedOnly ? (
                    <span className="ml-2 rounded-full border border-ink/15 px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.12em] text-ink-faint">
                      API key
                    </span>
                  ) : null}
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {r.rank != null && r.rank > 0 ? (
                    <>
                      <span
                        style={{
                          color:
                            r.rank === 1
                              ? "var(--color-good)"
                              : "var(--color-ink)",
                        }}
                      >
                        #{r.rank}
                      </span>
                      <span className="text-ink-faint">/{r.totalRanked}</span>
                    </>
                  ) : (
                    <span className="text-[10px] uppercase tracking-[0.14em] text-ink-faint italic">
                      unresponsive
                    </span>
                  )}
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {r.p50Ms != null ? (
                    fmtMs(r.p50Ms)
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap text-ink-soft">
                  {r.successPct != null ? `${r.successPct.toFixed(2)}%` : "—"}
                </td>
                <td className="py-2.5 pl-3 text-right tabular-nums whitespace-nowrap text-ink-faint">
                  {errorCount(r)?.toLocaleString("en-US") ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10.5px] text-ink-faint">
        Rank counts live providers only; unresponsive endpoints keep
        recording success rate but hold no latency percentile. Errors
        (24h) = sample size × (1 − success rate).
      </p>
    </section>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className: string;
}) {
  return (
    <th
      className={`py-2 ${className} text-[10px] font-medium uppercase tracking-[0.16em] text-ink-muted`}
    >
      {children}
    </th>
  );
}
