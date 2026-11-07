import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A bench gaining a provider needs the cache keys to move, and remembering is
 * not working.
 *
 * spec.ts already says it, in the note on bench-unfiltered-v93: "A cached
 * entry holds the provider set current when it was written, so a bench gaining
 * a row needs the key to move or the row never appears." It was written on
 * 2026-10-21 after Nova's row stayed invisible for seven minutes of polling
 * and a field-by-field diff of the blob.
 *
 * Two PRs later it happened again, twice over. Pump Bridge (#3188) and
 * FOMO · Mobula (#3226) joined bench 268 and neither moved a key. Both were
 * live in the materialized blob, pump-bridge at p50 269.6 over 939 swaps and
 * fomo-mobula at 297.2 over 2,512, and the board showed 14 rows with ALL
 * selected while the blob held 16 ranked. The note did not prevent the thing
 * the note describes.
 *
 * So the invariant is a test. It hashes every bench's provider set and fails
 * when that hash moves without this file being updated, which cannot happen
 * without the author reading the message below and deciding about the keys.
 *
 * The same shape as the poller test in the harness: the failure is an
 * ABSENCE, a bump that did not happen, and nothing observable at runtime
 * reports it. The page simply renders a row short, which looks like the
 * harness not having data rather than the site not asking for it.
 */
const BENCH_DIR = join(import.meta.dir, "..", "..", "benchmarks");

/** slug -> its provider slugs, read from the YAML without a parser so this
 *  test cannot be broken by a schema change it is not about. */
function providerSets(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(BENCH_DIR).filter((f) => f.endsWith(".yml")).sort()) {
    const src = readFileSync(join(BENCH_DIR, f), "utf8");
    // Providers are the "  - slug: x" entries under `providers:`; the bench's
    // own top-level `slug:` has no leading dash and is not matched.
    const slugs = [...src.matchAll(/^\s+-\s+slug:\s*([A-Za-z0-9._-]+)\s*$/gm)]
      .map((m) => m[1])
      .sort();
    if (slugs.length) out.push(`${f}:${slugs.join(",")}`);
  }
  return out;
}

describe("the provider set behind the cache keys", () => {
  test("has not changed without someone deciding about the cache keys", () => {
    const sets = providerSets();
    const hash = createHash("sha256").update(sets.join("\n")).digest("hex").slice(0, 16);
    const count = sets.reduce((n, s) => n + s.split(":")[1].split(",").length, 0);

    // An ADDITION on 2026-11-07: BlockVectra joins the public cohorts on
    // ethereum-rpc and arbitrum-rpc (issue #3573). A provider already on
    // the site, two more appearances: v189/v182/v107 and providers-v62.
    //
    // A REMOVAL on 2026-11-06: thirteen chain RPC pages retire (celo,
    // taiko, kaia, bob, bitlayer, gravity, axelar, hedera, litecoin,
    // soneium, zircuit, merlin, comdex), every row on them with them. No
    // human visitor since tracking began and no outside page pointing at
    // them; see removed-benches.ts. v187/v180/v105 and providers-v61.
    //
    // An ADDITION on 2026-11-05: bench 314 solana-rpc-ws returns, the
    // private Solana WebSocket race (chainstack, fluxrpc, getblock,
    // quicknode). A new bench with a region dimension: v168/v161/v93 and
    // providers-v55.
    //
    // An ADDITION on 2026-11-05: FluxRPC joins the keyed Solana cohort,
    // warm and cold (fluxrpc, fluxrpc-cold). New to the site, so a product
    // page too: v166/v159/v91 and providers-v54.
    //
    // An ADDITION on 2026-11-03: bench 026 validator-yield goes from 7
    // chains to 15 (aptos, near, kaia, algorand, icp, gram, sei, cronos,
    // the slugs the coordinator's registry PR uses). Rows on a board of
    // chains, no dimensions, so bench-filters stays; v149/v142 and
    // providers-v46 for the appearances.
    //
    // An ADDITION on 2026-11-03: bench 313 token-sellability, as a draft.
    // Its two rows are the two sell timings rather than two vendors, so
    // nobody gains a product page, but the provider index still carries the
    // appearances: v147/v140 and providers-v44. bench-filters does NOT move,
    // because the bench declares no dimensions and nothing is invisible on
    // a tab it does not have.
    //
    // A RETURN on 2026-11-06: Trnch is back on 033 and 304, reversing the
    // withdrawal below with their agreement. The ordering was the
    // withdrawal's in reverse, and for the same reason: the Railway key
    // went back on all three quote probes FIRST, because buildProviders
    // does not construct the provider without it, so the rows would have
    // published nothing had the spec landed first. v184/v177/v102 and
    // providers-v60; the product page did not move this time, because it
    // came back with bench 313 in #3511.
    //
    // A REMOVAL on 2026-11-03, one day after the arrival below: Trnch asked
    // not to be published on quote or latency for now, so both rows go and
    // the registry entry with them. The withdrawal happened in two steps and
    // the order mattered: the Railway key was deleted FIRST, which stops the
    // provider being constructed at all, so we stopped spending their rate
    // limit when they asked rather than when this merged. v142/v135/v80 and
    // providers-v40, which moves because a product page leaves too.
    //
    // Re-recorded on 2026-11-02 with bench-unfiltered-v139,
    // all-benchmarks-v132, bench-filters-v77, providers-v38: Trnch joins
    // benches 033 and 304 on Robinhood Chain. An ADDITION, and a provider
    // new to the site rather than to one bench, so providers-v moves for a
    // product page as well as for the appearances. It is key-gated: without
    // TRNCH_API_KEY the harness never builds it, which is how the row is
    // withdrawn if their terms are settled the other way.
    //
    // Re-recorded on 2026-11-02 with bench-unfiltered-v137,
    // all-benchmarks-v130, bench-filters-v75, providers-v36: SushiSwap
    // joins the two EVM quote benches, 033 and 304. An ADDITION, and the
    // case this test exists for. Both benches declare a chain dimension so
    // bench-filters moves, and the row gains two bench appearances under
    // the registry's existing `sushi` slug, so providers moves too or
    // /products, compare and answers keep listing it two benches short.
    //
    // Re-recorded on 2026-10-30 with bench-unfiltered-v129,
    // all-benchmarks-v122, bench-filters-v67, providers-v34: bench 312
    // paymaster-cost adds nine paymaster vendors.
    //
    // Re-recorded on 2026-10-29 with bench-unfiltered-v118,
    // all-benchmarks-v111, bench-filters-v56, providers-v31.
    //
    // Later the same evening the first three moved again, to v119/v112/v57,
    // for three rounds of bench 311 editorial. This hash did NOT move and
    // must not: it watches the provider SET, and no set changed. A hash that
    // tracked key bumps would have to be re-recorded for every copy edit and
    // would stop meaning anything.
    //
    // The change is an ADDITION, bench 311 rpc-api-coverage. All four keys
    // moved: it declares a chain dimension, so bench-filters is not optional,
    // and its six providers gain an appearance in the RPCs category, so
    // providers-v moves too or /products, compare and answers keep listing
    // them one bench short.
    //
    // Second ADDITION: Helius enters the keyed Solana cohort of
    // solana-rpc, warm and cold, on 2026-10-30. It is the one
    // Solana-native provider the review named that we can actually use,
    // Triton being paid only, and it had never been probed: the harness
    // listed it and budgeted it, the Railway URL variable was simply never
    // set, so the published cohort was Alchemy, Chainstack, GetBlock and
    // Quicknode. All four keys moved again, providers-v32 included, since a
    // provider ENTERING is the case that key exists for. The `-cold` twin
    // needed its alias in BOTH tables, logo-manifest and providers, which
    // three sibling tests caught before this one did.
    // A REMOVAL this time, on 2026-11-02: bench 311 rpc-api-coverage is
    // retired and its API capability matrix moves onto the eight chain RPC
    // pages, under the Private tab. The data is per (provider, chain), which
    // is the granularity of a chain page, so a cross-chain board was the
    // wrong home for it and its all-chains view had to average a provider
    // over whichever chains it served. Six providers therefore LOSE an
    // appearance in the RPCs category, which is the case providers-v exists
    // for as much as an arrival is: v38 to v39, with the other three at
    // v140/v133/v78.
    // An ARRIVAL on 2026-11-03: BlockVectra's keyless endpoints join the
    // Ink, Unichain and Fraxtal RPC pages (issue #3462). New to the site,
    // so providers-v moves with the other three: v41, v143/v136/v81.
    // An ADDITION on 2026-11-03: a keyed-heavy tier on the eight chain RPC
    // pages, six providers each under a `-heavy` slug, measured on a
    // Multicall3 of fifty state reads. Both alias tables gained a line per
    // vendor in the same change, for the reason the cold tier's comment in
    // providers.ts spells out: a tier slug without an alias builds its own
    // /products page with the vendor's title. All four keys moved.
    // 2026-11-03: BlockVectra joins the Katana RPC page (issue #3462), one
    // more appearance for a provider already on the site: v52, v157/v150/v87.
    expect(
      hash,
      [
        "A bench's provider set changed, which means a cached entry written",
        "before your change holds the OLD set and the new row will never",
        "appear on the page however good the data is.",
        "",
        "Before updating the hash below, move the keys in src/lib/spec.ts:",
        "  bench-unfiltered-vN   always",
        "  all-benchmarks-vM     always, and its lockstep note names the new N",
        "  bench-filters-vK      if the bench declares dimensions, or the row",
        "                        is invisible on every tab but the default",
        "  providers-vP          in src/lib/providers.ts, or /products,",
        "                        compare and answers keep the old appearances",
        "",
        "Then set EXPECTED to the hash in this failure, and add the provider",
        `to PRODUCT_NAMES if it needs a display name. Providers now: ${count}.`,
      ].join("\n"),
    ).toBe("e0e5b0e42ccb7ee7");
  });
});
