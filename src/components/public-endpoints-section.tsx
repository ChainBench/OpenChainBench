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
 * API-key cohort (tier: keyed, same page behind the Endpoints selector)
 * can leak through this component. They are named, with a link to the
 * keyed tab, never with a URL.
 */
import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import { CopyButton } from "@/components/copy-button";
import { fmtUnit } from "@/lib/format";
import { canonicalize } from "@/lib/providers";
import { EVM_CHAIN_IDS } from "@/lib/evm-chain-ids";
import { LEADER_MIN_SUCCESS_PCT, rpcChainLabel } from "@/lib/citation";
import { belowDisplayFloor, displayResults, liveResults, MIN_DISPLAY_SUCCESS_PCT } from "@/lib/provider-filters";
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

/**
 * Declared endpoints that answer, but almost never.
 *
 * publicEndpointRows starts from displayResults, a 5 % success floor, so a
 * provider below it vanished from the page entirely: the spec named it, the
 * probes measured it, and the reader saw a shorter list with no hint that
 * anything was missing. On 2026-10-02 Thirdweb was declared on 31 chain RPC
 * benches and ranked on none, at 0.3 % to 1.5 % success across 29 chains,
 * while answering 25 of 25 calls from a consumer connection. That gap is the
 * most useful thing we know about it, because our readers deploy on servers
 * and will meet the same wall.
 *
 * So the measurement gets published instead of dropped. The block is derived,
 * never authored: an endpoint that starts answering rejoins the list above on
 * its own, and one that stops falls here without anyone editing a spec. The
 * authored `excludedProviders` block below is for the other kind of absence,
 * a provider we chose not to probe.
 */
export function silentEndpointRows(benchmark: Benchmark) {
  return belowDisplayFloor(benchmark.results).filter((r) => r.endpoint && !r.unrankedLabel);
}

export async function PublicEndpointsSection({ benchmark }: { benchmark: Benchmark }) {
  const rows = publicEndpointRows(benchmark);
  const silent = silentEndpointRows(benchmark);
  // One usable endpoint was not worth a section listing URLs to paste. It is
  // worth one as soon as another endpoint is declared and silent, because
  // that is exactly the page where a reader would otherwise conclude the
  // chain has a single provider: the pages needing the explanation most were
  // the ones bailing out before it (iotex-rpc, 2026-10-02).
  if (rows.length < 2 && silent.length === 0) return null;
  if (rows.length === 0) return null;

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
  // 2026-09-19) wants the keyed providers named too. They are the bench's
  // own API-key cohort (tier dimension), ranked behind the Endpoints
  // selector; named here with a link to that tab, never with a URL.
  const keyedTier = benchmark.dimensions?.tier?.find((t) => t.value === "keyed");
  const keyedNames = keyedTier
    ? liveResults(benchmark.tierResults?.keyed ?? []).map((r) => r.name)
    : [];
  const keyed = keyedTier && keyedNames.length > 0 ? { slug: benchmark.slug } : null;
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
            {keyedNames[keyedNames.length - 1]}, private endpoints that need an API key, are ranked separately under the{" "}
            <Link href={`/benchmarks/${keyed.slug}#tier=keyed`} className="underline underline-offset-2">
              Private tab
            </Link>
            ; keyed URLs are never listed.
          </>
        ) : (
          <>Private providers (API key) are never listed with a URL.</>
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
      {silent.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium text-ink">
            Declared, but not answering our probes
          </h3>
          <p className="mt-1 text-[12.5px] text-ink-soft leading-snug">
            {silent.length === 1 ? "This endpoint is" : "These endpoints are"} named in the spec and
            probed on the same schedule as the rest, and {silent.length === 1 ? "answers" : "answer"}{" "}
            too rarely to carry a median. Below {MIN_DISPLAY_SUCCESS_PCT} % success we leave{" "}
            {silent.length === 1 ? "it" : "them"} out of the table rather than publish a latency drawn
            from a handful of replies. A provider can serve a browser and refuse a datacenter, so this
            says what a server deployment would meet, not what the endpoint is capable of.
          </p>
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {silent.map((r) => (
              <li key={r.slug} className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium text-ink">{r.name}</span>
                <code className="font-mono text-[11.5px] text-ink-faint truncate max-w-full" title={r.endpoint}>
                  {r.endpoint}
                </code>
                <span className="tabular-nums text-ink-soft">
                  {r.successRate.toFixed(1)} % success over 24 h
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
