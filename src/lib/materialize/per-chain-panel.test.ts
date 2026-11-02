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

describe("a panel scoped to one tier", () => {
  // API capability is probed on the keyed endpoints only. On a chain page's
  // public tab those panels have nothing to say, and a column pointing at a
  // panel with no values draws dashes under a header that promises a
  // reading, because colValue resolves a missing panel to null and the
  // table renders the column anyway.
  test("is published on its tier", () => {
    expect(publishesPanelOnView({ tiers: ["keyed"] }, { tier: "keyed" })).toBe(true);
  });

  test("is absent on every other tier", () => {
    expect(publishesPanelOnView({ tiers: ["keyed"] }, { tier: "public" })).toBe(false);
    expect(publishesPanelOnView({ tiers: ["keyed"] }, { tier: "keyed-cold" })).toBe(false);
  });

  test("is absent when no tier is pinned at all", () => {
    // A spec with no tier dimension must not acquire a keyed-only panel.
    expect(publishesPanelOnView({ tiers: ["keyed"] }, {})).toBe(false);
  });

  test("leaves panels that declare no tier alone", () => {
    expect(publishesPanelOnView({}, { tier: "public" })).toBe(true);
    expect(publishesPanelOnView({ tiers: [] }, { tier: "public" })).toBe(true);
  });

  test("composes with per_chain_only rather than overriding it", () => {
    const panel = { per_chain_only: true, tiers: ["keyed"] };
    expect(publishesPanelOnView(panel, { chain: "ethereum", tier: "keyed" })).toBe(true);
    expect(publishesPanelOnView(panel, { tier: "keyed" })).toBe(false);
    expect(publishesPanelOnView(panel, { chain: "ethereum", tier: "public" })).toBe(false);
  });
});

describe("the eight chain RPC pages that gained a capability matrix", () => {
  const CHAINS = ["ethereum", "base", "arbitrum", "polygon", "bnb", "arc", "hyperliquid", "robinhood"];
  const read = (c: string) =>
    load(
      readFileSync(join(import.meta.dir, `../../../benchmarks/${c}-rpc.yml`), "utf8"),
    ) as {
      metric_panels?: { id: string; tiers?: string[] }[];
      ledger_columns?: { label: string; slot?: string; panel?: string }[];
    };

  test("every capability panel is keyed-only", () => {
    for (const c of CHAINS) {
      const spec = read(c);
      const caps = (spec.metric_panels ?? []).filter((p) => p.id.startsWith("cap_"));
      expect(caps.length).toBe(8);
      for (const p of caps) expect(p.tiers).toEqual(["keyed"]);
    }
  });

  test("the public tab keeps its three latency columns", () => {
    // The regression this guards: declaring any ledger_columns switches the
    // table out of its default layout. Without p50/p90/p99 re-declared, the
    // public cohort would silently lose p90 and p99 on eight pages.
    for (const c of CHAINS) {
      const cols = read(c).ledger_columns ?? [];
      const slots = cols.filter((x) => x.slot).map((x) => x.slot);
      expect(slots).toEqual(["p50", "p90", "p99"]);
      expect(cols[0]?.slot).toBe("p50");
    }
  });

  test("every declared column resolves to a panel that exists", () => {
    for (const c of CHAINS) {
      const spec = read(c);
      const ids = new Set((spec.metric_panels ?? []).map((p) => p.id));
      for (const col of spec.ledger_columns ?? []) {
        if (col.panel) expect(ids).toContain(col.panel);
      }
    }
  });

  test("each page queries its own chain and no other", () => {
    // One wrong chain literal copied eight times is eight pages showing
    // Ethereum's capability under another chain's name.
    for (const c of CHAINS) {
      const spec = read(c) as unknown as { metric_panels?: { id: string; metric: string }[] };
      for (const p of (spec.metric_panels ?? []).filter((x) => x.id.startsWith("cap_"))) {
        expect(p.metric).toContain(`chain="${c}"`);
      }
    }
  });
});
