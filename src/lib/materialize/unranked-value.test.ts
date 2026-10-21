import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

/**
 * `provider.unranked` carried two different claims under one label.
 *
 * On the four specs that shipped the field first it means "no publishable
 * value exists": a perp DEX pre-TGE, an RWA with no open market. On bench 304
 * it means "measured, but not comparable to the ranked field": CoW and Bebop
 * are RFQ venues and LI.FI is a relayer, and their shortfall is a real number
 * a reader wants. The loader zeroed the percentiles for both, so bench 304
 * published CoW, Bebop, LI.FI and Route at 0.00 bps while Bebop was giving up
 * around a hundred.
 *
 * Probed on 2026-10-19: of the eleven labelled rows across perp-liq-rate,
 * perp-pf-ratio, rpc-free-tier and rwa-solana-depth, ten return nothing from
 * Prometheus and never reach the loop, so the zero was load-bearing on
 * exactly one row, perp-pf-ratio's Paradex at 29.85 off an adapter the spec
 * itself labels incomplete. Keeping the value is therefore the right default
 * and the blanking is opt-in.
 *
 * Asserted against the source and the specs rather than a render: the loop
 * lives inside loadBenchmark behind a live Prometheus fetch, and what is
 * worth pinning is that the branch exists and that the one row relying on it
 * still asks for it.
 */
const SRC = readFileSync(join(import.meta.dir, "load.ts"), "utf8");
const BENCH = join(import.meta.dir, "..", "..", "..", "benchmarks");

type Spec = {
  providers?: { slug: string; unranked?: string; unranked_hides_value?: boolean }[];
};

function spec(slug: string): Spec {
  return yaml.load(readFileSync(join(BENCH, `${slug}.yml`), "utf8")) as Spec;
}

describe("an unranked row keeps its measured value", () => {
  test("the loader blanks the percentiles only when the spec asks", () => {
    expect(SRC).toContain("if (entry.hide) r.ms = { p50: 0, p90: 0, p99: 0, mean: 0 }");
    // The label and the liveness still apply to every labelled row; only
    // the blanking is conditional.
    expect(SRC).toContain("r.unrankedLabel = entry.label");
  });

  test("bench 304's RFQ and relayer rows publish what they measure", () => {
    const rows = (spec("evm-quote-output").providers ?? []).filter(
      (p) => p.unranked,
    );
    expect(rows.map((p) => p.slug).sort()).toEqual(["bebop", "cow", "lifi"]);
    for (const p of rows) expect(p.unranked_hides_value ?? false).toBe(false);
  });

  test("Route is labelled by the coverage rule, not by the spec", () => {
    // A spec-declared label applies to every tab. Route quotes one chain, so
    // declaring it would pull Route out of the ranking on the one chain it
    // actually quotes. score_scope: full_coverage computes the same label,
    // and only where the figure is incomparable: the all-chains view.
    const route = (spec("evm-quote-output").providers ?? []).find(
      (p) => p.slug === "route",
    );
    expect(route).toBeDefined();
    expect(route?.unranked).toBeUndefined();
  });

  test("the label applies on a chain tab too, not only the all view", () => {
    // "Never ranked, never a leader" is a property of the provider, not of
    // the view. The block had been swept inside the `if (!isFiltered)` guard
    // that gates augmenting missing providers, so every chain tab lost the
    // labels: bench 304's BSC tab ranked Bebop and LI.FI inside the router
    // order its own methodology says they are kept out of. Pinned by indent,
    // which is what moving it back under the guard would change.
    expect(SRC).toContain("\n    const unrankedBySlug = new Map(");
    expect(SRC).not.toContain("\n      const unrankedBySlug = new Map(");
  });

  test("Paradex still asks to be blanked", () => {
    const paradex = (spec("perp-pf-ratio").providers ?? []).find(
      (p) => p.slug === "paradex",
    );
    expect(paradex?.unranked).toBe("Adapter incomplete");
    expect(paradex?.unranked_hides_value).toBe(true);
  });

  test("the frozen Coinbase feed stays unranked and blanked on both benches", () => {
    // A frozen upstream passes every freshness check we have, because they
    // all read a refresh timestamp and it keeps advancing. The only thing
    // standing between that feed and a published figure is these two
    // declarations, so they are worth pinning: dropping either one puts
    // Coinbase back at 227 bps on perp-funding-cost-30d, last in the field
    // by a factor of two and a half, on twenty days of one repeated number.
    for (const slug of ["perp-funding-cost-30d", "perp-funding-stability"]) {
      const row = (spec(slug).providers ?? []).find(
        (p) => p.slug === "coinbase-international",
      );
      expect(row, `${slug} must still declare coinbase-international`).toBeDefined();
      expect(row?.unranked).toBe("Upstream frozen");
      expect(row?.unranked_hides_value).toBe(true);
    }
  });

  test("no other spec silently depends on the old default", () => {
    // A row labelled unranked on any other spec returned nothing from
    // Prometheus when this was probed, so it never reached the zeroing. If a
    // new one appears, this test is the prompt to re-probe it rather than
    // assume.
    //
    // 2026-10-21, two more were added and probed as this test asks. Both are
    // Coinbase International, whose Mobula funding series has returned the
    // same number since 1 October: 9.36 bps a day on ETH, 14.16 on BTC,
    // 23.76 on SOL, min equal to max over every window out to 20.3 days
    // while its refresh gauge stays current to the second. The series does
    // return a value, so the zeroing is reached, and that is the point: the
    // headline is not rendered for an unranked row, and the zero is what
    // keeps the frozen figure out of the compare cards, which filter on
    // `r.ms.p50 !== 0`. Without it perp-funding-cost-30d published the row
    // last at 227 bps on a window two thirds of which was one reading.
    const known = new Set([
      "evm-quote-output",
      "perp-pf-ratio",
      "perp-funding-cost-30d",
      "perp-funding-stability",
    ]);
    const offenders: string[] = [];
    for (const f of readdirSync(BENCH)) {
      if (!f.endsWith(".yml")) continue;
      const slug = f.slice(0, -4);
      if (known.has(slug)) continue;
      for (const p of spec(slug).providers ?? []) {
        if (p.unranked && p.unranked_hides_value) offenders.push(`${slug}/${p.slug}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
