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

    // Recorded on 2026-11-13 on main with bench-unfiltered-v123,
    // all-benchmarks-v116, providers-v37: MOJO joins bench 030 as its
    // 108th Hyperliquid builder (#3601), opened by the operator. New to
    // the site, so providers-v moves; bench 030 declares no dimensions,
    // so bench-filters does NOT. Every figure in the request was
    // recomputed from the public builder-fills bucket before merge:
    // 1,365 fills, $142,513 of notional, $71.26 of builder fees, 113
    // wallets, exactly 5.0 bp on all 1,365 fills, and zero fills whose
    // counterparty is another wallet of that cohort.
    //
    // Previously recorded on 2026-11-12 on main with bench-unfiltered-v122,
    // all-benchmarks-v115, bench-filters-v60, providers-v36: BlockVectra
    // joins the public Boba and World Chain cohorts (#3594). Two more
    // appearances for a provider already on the site, all three region
    // tabs on each. Probed before merge: chain id 0x120 and 0x1e0, heads
    // 0 and 1 s old, a batch of ten accepted.
    //
    // Previously recorded on 2026-11-12 on main with bench-unfiltered-v120,
    // all-benchmarks-v113, bench-filters-v58, providers-v35: BlockVectra
    // joins the public Optimism cohort (#3585), an outside contribution.
    // A provider already on the site, one more appearance, and all three
    // region tabs. The endpoint was probed before merge: chain id 0xa, a
    // head 0 s old, a batch of ten accepted, 230 ms. The numbering is
    // main's own, not dev's: the branches diverged in October.
    //
    // Previously recorded on 2026-11-10 on main with bench-unfiltered-v118,
    // all-benchmarks-v111, bench-filters-v56, providers-v34: Thyme Gate
    // joins the public cohorts on ethereum, polygon, optimism and bnb
    // (#3586, an outside contribution). New to the site, so providers-v
    // moves with the other three, and all four benches declare regions so
    // every region tab moves with the unfiltered view. The four endpoints
    // were checked before merge rather than taken on the contributor's
    // word: right chain id, a head block 0 to 10 s old, a batch of ten
    // accepted. The numbering here is main's own, not the numbering the
    // same change carries on dev, because the branches diverged in
    // October.
    //
    // Previously recorded on 2026-11-07 on main with bench-unfiltered-v116,
    // all-benchmarks-v109, bench-filters-v55, providers-v32: BlockVectra
    // joins the public cohorts on ethereum-rpc and arbitrum-rpc (#3573).
    //
    // Previously recorded on 2026-11-06 on main with bench-unfiltered-v115,
    // all-benchmarks-v108, bench-filters-v54, providers-v31: thirteen chain
    // RPC pages retire (celo, taiko, kaia, bob, bitlayer, gravity, axelar,
    // hedera, litecoin, soneium, zircuit, merlin, comdex).
    //
    // Previously recorded on 2026-10-29 on main with bench-unfiltered-v106,
    // all-benchmarks-v99, bench-filters-v46, providers-v22: bench 309
    // wallet-cost released with thirteen embedded wallet vendors.
    //
    // Previously recorded on 2026-10-28 on main, with bench-unfiltered-v102,
    // all-benchmarks-v95, bench-filters-v43, providers-v21, none of which
    // moved. Read the next paragraph before copying that as a precedent.
    //
    // Two merges moved the set and neither bumped a key: #3311 stopped
    // scoring Mobula on Solana in token-quote-coverage, and #3312 added
    // Perpex to hyperliquid-frontends. Both touched only benchmarks/*.yml,
    // so this guard went red on main on 2026-10-27 and stayed red, which is
    // exactly what it exists to do.
    //
    // The keys are NOT moved retroactively, and that is a judgement about
    // timing rather than a softening of the rule. A key bump invalidates
    // entries written BEFORE the change; by 2026-10-28 the cache had already
    // turned over on its own, verified rather than assumed: production
    // serves 106 providers on hyperliquid-frontends including Perpex, and
    // /products/perpex answers 200 carrying its hyperliquid-frontends
    // appearance. Bumping now would flush healthy entries and surface
    // nothing new. Had this been caught the same day, the keys would have
    // had to move, and for the next change they still do.
    // An ARRIVAL on 2026-11-03: BlockVectra joins the Ink, Unichain and
    // Fraxtal RPC pages (issue #3462). New to the site, so all four keys
    // move: v108/v101/v48 and providers-v24.
    // 2026-11-03: BlockVectra joins the Katana RPC page (issue #3462), one
    // more appearance for a provider already on the site: v27, v110/v103/v50.
    // An ADDITION on production, 2026-11-04: the eight chain RPC pages gain
    // a keyed-heavy tier, six providers each under a `-heavy` slug, measured
    // on a Multicall3 of fifty state reads. Both alias tables gained a line
    // per vendor in the same change, for the reason the cold tier's comment
    // in providers.ts spells out: a tier slug without an alias builds its own
    // /products page carrying the vendor's title. All four keys moved,
    // v110/v103/v50/v27 to v111/v104/v51/v28.
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
    ).toBe("35271608c8174d1e");
  });
});
