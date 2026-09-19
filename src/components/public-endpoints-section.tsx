/**
 * "Public endpoints measured": the URL next to the number.
 *
 * Search Console (2026-09-19): 298 "<chain> rpc" queries, 2,295 impressions,
 * 1 click, median position 56. The searcher wants the endpoint and the
 * provider list; the page only showed latency. This block lists every
 * provider of the bench that declares a public no-key `endpoint` in the
 * spec, with its current p50 and success rate, so the first screen of the
 * page answers "which X RPC, and what is the URL" before the methodology.
 *
 * Keyed providers never appear here: `provider.endpoint` is refused by
 * the spec schema when the URL carries a token, so nothing from the
 * keyed benches can leak through this component.
 */
import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import { CopyButton } from "@/components/copy-button";
import { fmtUnit } from "@/lib/format";
import { canonicalize } from "@/lib/providers";
import { EVM_CHAIN_IDS } from "@/lib/evm-chain-ids";
import { CHAIN_BY_SLUG } from "@/lib/chains";
import type { Benchmark } from "@/types/benchmark";

/** The endpoints the section lists: a declared public URL with a live
 *  24h measurement. A URL we cannot vouch for today (provider down,
 *  unresponsive, no samples) is not listed. Shared with the TL;DR so the
 *  count it announces is the count the table shows. */
export function publicEndpointRows(benchmark: Benchmark) {
  return benchmark.results
    .filter((r) => r.endpoint && !r.unrankedLabel && !r.unresponsive && r.availability !== "unavailable" && r.ms.p50 > 0)
    .sort((a, b) => (benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50));
}

export function PublicEndpointsSection({ benchmark }: { benchmark: Benchmark }) {
  const rows = publicEndpointRows(benchmark);
  if (rows.length < 2) return null;

  // "Ethereum RPC" from "Fastest free Ethereum RPC, live no-key ..." is not
  // derivable safely; the chain label comes from the first chain dimension
  // when the spec has one, else from the H1 pattern "<Chain> RPC".
  const chainLabel =
    benchmark.dimensions?.chain?.find((c) => c.value !== "all")?.label ??
    (benchmark.title.match(/free ([A-Za-z0-9 .-]+?) RPC/i)?.[1] ?? null);
  const chainSlug = benchmark.slug.replace(/-rpc$/, "");
  const chainId = EVM_CHAIN_IDS[chainSlug];
  const symbol = CHAIN_BY_SLUG.get(chainSlug)?.nativeSymbol;
  const heading = chainLabel
    ? `Public ${chainLabel} RPC endpoints measured`
    : "Public endpoints measured";

  return (
    <section className="mt-10 max-w-3xl" aria-labelledby="public-endpoints">
      <h2 id="public-endpoints" className="display text-2xl tracking-tight text-ink">
        {heading}
      </h2>
      <p className="mt-2 text-sm text-ink-soft leading-snug">
        {chainId ? <>Chain ID {chainId}{symbol ? <>, currency {symbol}</> : null}. </> : null}
        The {rows.length} no-key endpoints answering our probes today, with
        their current 24h median. Paste one into a wallet or a client as is: no signup, no
        key. Providers that need an API key are compared on the keyed pages
        and are never listed with a URL.
      </p>
      <ul className="mt-4 divide-y divide-rule rounded-lg border border-rule card-soft">
        {rows.map((r) => {
          const canon = canonicalize(r.slug);
          return (
            <li key={r.slug} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <span className="flex items-center gap-2 min-w-[140px]">
                <ProviderLogo slug={r.slug} name={r.name} size={18} />
                <Link href={`/products/${canon.slug}`} className="font-medium text-ink hover:underline underline-offset-2">
                  {r.name}
                </Link>
              </span>
              <code className="flex-1 min-w-0 truncate font-mono text-[12px] text-ink-soft" title={r.endpoint}>
                {r.endpoint}
              </code>
              <CopyButton value={r.endpoint!} label="Copy" />
              <span className="w-[72px] text-right tabular-nums text-ink-soft">
                {fmtUnit(r.ms.p50, benchmark.unit)}
              </span>
              <span className="w-[56px] text-right tabular-nums text-ink-faint text-[12px]">
                {`${r.successRate.toFixed(1)}%`}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[12px] text-ink-faint">
        Median round-trip and success rate over the last 24 hours across the
        probe regions; the ranked table above carries p90, p99 and the
        per-region split.
      </p>
    </section>
  );
}
