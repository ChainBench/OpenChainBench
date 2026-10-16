import { describe, expect, it } from "bun:test";
import {
  scopeCohortToRegion,
  type RpcHubChain,
  type RpcHubCohort,
} from "@/lib/rpc-hub-shape";

/**
 * The /rpc geo view, pinned on the shapes the staging payload actually
 * ships (the private cohort on 2026-10-16: 53 provider x chain cells, all
 * three regions present except 8 cells with no Singapore point of
 * presence).
 *
 * What the scope has to get right is which figures survive it. A region's
 * p50 exists per provider, so it substitutes cleanly. A p90 does not: the
 * blob computes the tail across all three regions, and carrying it into a
 * column headed "Singapore" would publish a 3-region number as a regional
 * one. Same for the leader's sparkline, which belongs to whoever led
 * overall.
 */

const chain = (
  slug: string,
  providers: {
    provider: string;
    p50Ms: number;
    regions: Record<string, number>;
    successPct?: number;
    sampleSize?: number;
  }[],
  extra: Partial<RpcHubChain> = {},
): RpcHubChain => {
  const field = providers.map((p) => ({
    provider: p.provider,
    name: p.provider,
    p50Ms: p.p50Ms,
    p90Ms: p.p50Ms * 3,
    regions: p.regions,
    ...(p.successPct != null ? { successPct: p.successPct } : {}),
    ...(p.sampleSize != null ? { sampleSize: p.sampleSize } : {}),
  }));
  const leader = field[0];
  return {
    chain: slug.replace(/-rpc$/, ""),
    slug,
    name: slug,
    benchTitle: slug,
    providerCount: field.length,
    best: {
      provider: leader.provider,
      providerName: leader.name,
      p50Ms: leader.p50Ms,
    },
    bestP90Ms: leader.p90Ms,
    regions: {},
    providers: field,
    series: [1, 2, 3],
    updatedAt: "2026-10-16T10:00:00Z",
    ...extra,
  };
};

/** Arbitrum's real shape: QuickNode leads overall and from Singapore,
 *  Chainstack is quicker from EU-West. Plus a vendor with no Singapore
 *  point of presence, and a chain measured from nowhere but us-east. */
const cohort = (): RpcHubCohort => ({
  chains: [
    chain("arbitrum-rpc", [
      {
        provider: "quicknode",
        p50Ms: 6.2,
        regions: { "us-east": 5.8, "eu-west": 8.2, sgp: 4.5 },
        successPct: 100,
        sampleSize: 700,
      },
      {
        provider: "chainstack",
        p50Ms: 7.1,
        regions: { "us-east": 6.9, "eu-west": 6.0, sgp: 9.8 },
        successPct: 99.8,
        sampleSize: 700,
      },
      {
        provider: "validationcloud",
        p50Ms: 20.4,
        regions: { "us-east": 19.1, "eu-west": 21.7 },
      },
    ]),
    chain("arc-rpc", [
      { provider: "alchemy", p50Ms: 30.1, regions: { "us-east": 30.1 } },
    ]),
  ],
  providersPivot: [],
  totals: { chains: 2, uniqueProviders: 3, regions: 3 },
});

describe("scopeCohortToRegion", () => {
  it("substitutes that region's p50 for every provider", () => {
    const sgp = scopeCohortToRegion(cohort(), "sgp");
    const arb = sgp.chains.find((c) => c.slug === "arbitrum-rpc");
    expect(arb?.providers.map((p) => [p.provider, p.p50Ms])).toEqual([
      ["quicknode", 4.5],
      ["chainstack", 9.8],
    ]);
  });

  it("re-ranks, so a provider that only wins one region wins there", () => {
    const eu = scopeCohortToRegion(cohort(), "eu-west");
    const arb = eu.chains.find((c) => c.slug === "arbitrum-rpc");
    // QuickNode leads the blended board at 6.2; from EU-West it is 8.2
    // against Chainstack's 6.0, and the leader has to change with it.
    expect(arb?.best).toEqual({
      provider: "chainstack",
      providerName: "chainstack",
      p50Ms: 6.0,
    });
    expect(arb?.regions).toEqual({
      "eu-west": {
        provider: "chainstack",
        providerName: "chainstack",
        p50Ms: 6.0,
      },
    });
  });

  it("drops a provider with no point of presence in the region", () => {
    const sgp = scopeCohortToRegion(cohort(), "sgp");
    const arb = sgp.chains.find((c) => c.slug === "arbitrum-rpc");
    expect(arb?.providers.map((p) => p.provider)).not.toContain(
      "validationcloud",
    );
    expect(arb?.providerCount).toBe(2);
  });

  it("drops a chain nobody answers from the region", () => {
    const sgp = scopeCohortToRegion(cohort(), "sgp");
    expect(sgp.chains.map((c) => c.slug)).toEqual(["arbitrum-rpc"]);
    expect(sgp.totals.chains).toBe(1);
    expect(sgp.totals.regions).toBe(1);
  });

  it("clears the tails rather than publish a 3-region p90 as regional", () => {
    const sgp = scopeCohortToRegion(cohort(), "sgp");
    for (const c of sgp.chains) {
      expect(c.bestP90Ms).toBeUndefined();
      for (const p of c.providers) expect(p.p90Ms).toBeUndefined();
    }
  });

  it("keeps the leader's sparkline only when the leader is the same row", () => {
    const sgp = scopeCohortToRegion(cohort(), "sgp");
    // QuickNode leads both blended and from Singapore: the series is its own.
    expect(sgp.chains[0]?.series).toEqual([1, 2, 3]);

    const eu = scopeCohortToRegion(cohort(), "eu-west");
    const arb = eu.chains.find((c) => c.slug === "arbitrum-rpc");
    // Chainstack leads EU-West, so the stored series belongs to QuickNode.
    expect(arb?.series).toBeUndefined();
  });

  it("rebuilds the pivot on the region's ordering", () => {
    const eu = scopeCohortToRegion(cohort(), "eu-west");
    const byProvider = Object.fromEntries(
      eu.providersPivot.map((r) => [r.provider, r]),
    );
    expect(byProvider.chainstack?.chains.arbitrum).toEqual({
      p50Ms: 6.0,
      rank: 1,
      successPct: 99.8,
      sampleSize: 700,
    });
    expect(byProvider.quicknode?.chains.arbitrum?.rank).toBe(2);
    expect(byProvider.quicknode?.chains.arbitrum?.p50Ms).toBe(8.2);
    expect(eu.totals.uniqueProviders).toBe(eu.providersPivot.length);
  });

  it("carries reliability and archive through untouched", () => {
    const base = cohort();
    base.chains[0]!.providers[0]!.archiveDepth = {
      supportedBlocks: [300, 7200],
    };
    const sgp = scopeCohortToRegion(base, "sgp");
    const qn = sgp.chains[0]?.providers[0];
    expect(qn?.archiveDepth?.supportedBlocks).toEqual([300, 7200]);
    expect(qn?.successPct).toBe(100);
    expect(qn?.sampleSize).toBe(700);
  });

  it("leaves the unscoped cohort alone", () => {
    const base = cohort();
    const before = JSON.stringify(base);
    scopeCohortToRegion(base, "sgp");
    expect(JSON.stringify(base)).toBe(before);
  });
});
