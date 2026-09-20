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
import { LEADER_MIN_SUCCESS_PCT, rpcChainLabel } from "@/lib/citation";
import { displayResults } from "@/lib/provider-filters";
import { getSpecs } from "@/lib/spec";
import { CHAIN_BY_SLUG } from "@/lib/chains";
import type { Benchmark } from "@/types/benchmark";

/** The endpoints the section lists: a declared public URL with a live
 *  24h measurement above the display floor (the same set the Results
 *  table and the TL;DR count use). Endpoints above the citation success
 *  floor come first, sorted by p50, so row one is the crowned leader;
 *  the rest follow, flagged, sorted by p50 too. Shared with the TL;DR so
 *  the count it announces is the count the table shows. */
export function publicEndpointRows(benchmark: Benchmark) {
  const dir = benchmark.higherIsBetter ? -1 : 1;
  return displayResults(benchmark.results)
    .filter((r) => r.endpoint && !r.unrankedLabel)
    .sort((a, b) => {
      const fa = (a.successRate ?? 100) >= LEADER_MIN_SUCCESS_PCT ? 0 : 1;
      const fb = (b.successRate ?? 100) >= LEADER_MIN_SUCCESS_PCT ? 0 : 1;
      return fa - fb || dir * (a.ms.p50 - b.ms.p50);
    });
}

export async function PublicEndpointsSection({ benchmark }: { benchmark: Benchmark }) {
  const rows = publicEndpointRows(benchmark);
  if (rows.length < 2) return null;

  // Chain entity for the H2, from the title patterns the cluster uses
  // (both the "Fastest free X RPC" and the "X RPC endpoints" shapes),
  // else the first chain dimension.
  const chainLabel =
    rpcChainLabel(benchmark) ??
    benchmark.dimensions?.chain?.find((c) => c.value !== "all")?.label ??
    null;
  const chainSlug = benchmark.slug.replace(/-rpc$/, "");
  const chainId = EVM_CHAIN_IDS[chainSlug];
  const symbol = CHAIN_BY_SLUG.get(chainSlug)?.nativeSymbol;
  const belowFloor = rows.filter((r) => (r.successRate ?? 100) < LEADER_MIN_SUCCESS_PCT).length;

  // The "<chain> rpc provider" searcher (414 impressions, 0 clicks on
  // 2026-09-19) wants the keyed providers named too. They are compared on
  // the keyed page when this deployment has one; named here, never with
  // a URL.
  const keyed = (await getSpecs().catch(() => [])).find(
    (sp) => sp.slug === `keyed-rpc-${chainSlug}`,
  );
  const keyedNames = keyed ? keyed.providers.map((pv) => pv.name) : [];
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
        their current 24h median
        {belowFloor > 0
          ? `; ${belowFloor} of them ${belowFloor === 1 ? "sits" : "sit"} below the ${LEADER_MIN_SUCCESS_PCT} % success floor and ${belowFloor === 1 ? "is" : "are"} listed last`
          : ""}
        . Paste one into a wallet or a client as is: no signup, no key.{" "}
        {keyed && keyedNames.length > 0 ? (
          <>
            {keyedNames.slice(0, -1).join(", ")}
            {keyedNames.length > 1 ? " and " : ""}
            {keyedNames[keyedNames.length - 1]}, which need an API key, are compared on the{" "}
            <Link href={`/benchmarks/${keyed.slug}`} className="underline underline-offset-2">
              keyed {chainLabel ?? ""} RPC page
            </Link>
            ; keyed URLs are never listed.
          </>
        ) : (
          <>Providers that need an API key are never listed with a URL.</>
        )}
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
              <CopyButton value={r.endpoint!} label="Copy" event={{ kind: "endpoint", value: r.endpoint!, bench: benchmark.slug }} />
              <span className="w-[72px] text-right tabular-nums text-ink-soft">
                {fmtUnit(r.ms.p50, benchmark.unit)}
              </span>
              <span
                className="w-[56px] text-right tabular-nums text-ink-faint text-[12px]"
                title={(r.successRate ?? 100) < LEADER_MIN_SUCCESS_PCT ? `Below the ${LEADER_MIN_SUCCESS_PCT} % success floor: not eligible for the headline` : undefined}
              >
                {`${r.successRate.toFixed(1)}%`}
                {(r.successRate ?? 100) < LEADER_MIN_SUCCESS_PCT ? " ▾" : ""}
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
      {benchmark.excludedProviders && benchmark.excludedProviders.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-ink">
            Not listed on {chainLabel ?? "this chain"}
          </h3>
          <ul className="mt-1.5 space-y-1 text-[12.5px] text-ink-soft">
            {benchmark.excludedProviders.map((x) => (
              <li key={x.name}>
                <span className="font-medium text-ink">{x.name}</span>: {x.reason}
                {x.since ? <span className="text-ink-faint"> (since {x.since})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
