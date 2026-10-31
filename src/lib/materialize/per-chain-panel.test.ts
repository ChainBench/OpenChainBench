import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { publishesPanelOnView } from "@/lib/materialize/load";

/**
 * A per-chain quantity has no pooled form.
 *
 * The three measured views on bench 311 were published as an average over
 * the chains where each provider happened to serve. Measured 2026-10-31, the
 * spread INSIDE one provider is larger than the spread between providers:
 * getblock reads 1.94 ms of eth_call work on Ethereum and 468.56 on
 * HyperEVM, so its pooled 61.49 was almost entirely one chain. A chain-count
 * floor would not have helped, since all three widest-spread providers are
 * measured on all eight chains.
 */
describe("publishesPanelOnView", () => {
  test("withholds a per-chain panel on the pooled view", () => {
    expect(publishesPanelOnView({ per_chain_only: true }, {})).toBe(false);
    expect(publishesPanelOnView({ per_chain_only: true }, { chain: undefined })).toBe(false);
  });

  test("publishes it on a chain tab", () => {
    expect(publishesPanelOnView({ per_chain_only: true }, { chain: "ethereum" })).toBe(true);
    expect(publishesPanelOnView({ per_chain_only: true }, { chain: "hyperliquid" })).toBe(true);
  });

  test("leaves every other panel alone, on either view", () => {
    // 260 of 261 specs declare no per-chain panel. None of them may lose a
    // view to this.
    expect(publishesPanelOnView({}, {})).toBe(true);
    expect(publishesPanelOnView({}, { chain: "base" })).toBe(true);
    expect(publishesPanelOnView({ per_chain_only: false }, {})).toBe(true);
  });
});

describe("the rule is written once, not per path", () => {
  // Panel VALUES and panel 7d/30d SERIES are built by different code, and
  // the series route is reachable by URL. A rule written twice is a rule
  // that holds in one of them: that is how bench 001's "First to report"
  // published one cross-chain average under every chain tab for months.
  const ROOT = join(import.meta.dir, "../../..");
  const route = readFileSync(
    join(ROOT, "src/app/api/series/[slug]/route.ts"),
    "utf8",
  );

  test("the series route calls the shared guard on both of its panel paths", () => {
    const calls = route.match(/publishesPanelOnView\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  test("the loader calls it too", () => {
    const loader = readFileSync(join(ROOT, "src/lib/materialize/load.ts"), "utf8");
    expect(loader).toContain("if (!publishesPanelOnView(panel, activeLabels)) continue;");
  });
});

describe("bench 311 declares it on the three measured views", () => {
  const spec = load(
    readFileSync(
      join(import.meta.dir, "../../../benchmarks/rpc-api-coverage.yml"),
      "utf8",
    ),
  ) as { metric_panels: { id: string; per_chain_only?: boolean; tab?: boolean }[] };

  test("the measured views are per-chain", () => {
    for (const id of ["eth_call_work_ms", "archive_read_ms", "getlogs_address_ms"]) {
      const p = spec.metric_panels.find((mp) => mp.id === id);
      expect(p).toBeDefined();
      expect(p?.per_chain_only).toBe(true);
    }
  });

  test("the capability shares are NOT, because a share of cells does pool", () => {
    // These are counts over cells, not milliseconds, so the all-chains tab
    // is their natural home and the board would be empty without them.
    for (const id of ["api_trace_block", "api_archive_5m", "api_getlogs_address"]) {
      const p = spec.metric_panels.find((mp) => mp.id === id);
      expect(p?.per_chain_only).toBeUndefined();
    }
  });
});
