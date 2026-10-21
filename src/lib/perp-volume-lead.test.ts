import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOTIONAL_NOT_COMPARABLE,
  perpVolumeLead,
  perpVolumeRanking,
  type PerpVenueRow,
} from "./perp-stats";

/**
 * /perps published "Papertrade leads 28 tracked perp DEXes on 30-day volume at
 * $2623.64B" on 2026-10-20.
 *
 * Hyperliquid's 24h volume that day was $4.26B, about $128B over a month, so
 * the claim put a two-market venue at twenty times the largest measured one.
 * Papertrade's own spec says "single house LP, BTC and ETH only" and "the four
 * side columns are summed because every position faces the house": its
 * notional is not the quantity a public order book reports.
 *
 * "Self-reported" is not the test and would exclude everyone, since
 * perp-daily-volume says in its own abstract that volume is self-reported by
 * every venue. What the number counts is the test.
 */
function row(
  slug: string,
  volume30d: number | null,
  venueType: PerpVenueRow["venueType"] = "onchain",
): PerpVenueRow {
  return {
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    chain: "x",
    venueType,
    volume24h: null,
    volume30d,
    openInterest: null,
    fees30d: null,
    activeMarkets: null,
    topMarketVolume24h: null,
    health: null,
  } as PerpVenueRow;
}

describe("the volume leader is a venue measuring the cohort's quantity", () => {
  const venues = [
    row("papertrade", 2_623_640_000_000),
    row("hyperliquid", 128_000_000_000),
    row("lighter", 40_000_000_000),
    row("binance", 900_000_000_000, "cex"),
  ];

  test("the house-LP venue does not lead, even posting the largest notional", () => {
    expect(perpVolumeLead(venues)?.slug).toBe("hyperliquid");
  });

  test("the CEX reference still does not lead either", () => {
    // Excluded for the adjacent reason, and already was before this change.
    expect(perpVolumeRanking(venues).map((v) => v.slug)).toEqual([
      "hyperliquid",
      "lighter",
    ]);
  });

  test("the runner-up comes from the same list as the leader", () => {
    // The FAQ reads "<lead> ... ahead of <second>". Taking the lead from the
    // eligible ranking and the runner-up from an unfiltered index printed
    // Hyperliquid twice, because Papertrade was index 0 and Hyperliquid 1.
    const ranking = perpVolumeRanking(venues);
    expect(ranking[0].slug).not.toBe(ranking[1].slug);
    expect(ranking[1].slug).toBe("lighter");
  });

  test("a venue with no volume is not ranked at all", () => {
    expect(perpVolumeRanking([row("ghost", null)])).toEqual([]);
    expect(perpVolumeLead([row("ghost", null)])).toBeNull();
    expect(perpVolumeLead([])).toBeNull();
    expect(perpVolumeLead(undefined)).toBeNull();
  });

  test("the exclusion is one named set, not a threshold", () => {
    // A threshold on notional or on market count would be a number nobody can
    // defend, and would silently catch a venue that grows into it.
    expect([...NOTIONAL_NOT_COMPARABLE]).toEqual(["papertrade"]);
  });

  test("all four surfaces draw their sentence from the helper", () => {
    // The meta description, the lede, the FAQ and the Markdown view each built
    // `sort by volume30d of everything that is not a CEX` on their own, so one
    // exclusion had to be added in four places or in none. It was added in none.
    const page = readFileSync(
      join(import.meta.dir, "..", "app", "perps", "page.tsx"),
      "utf8",
    );
    expect(page).toContain("perpVolumeLead(cohort?.venues)");
    expect(page).toContain("perpVolumeRanking(cohort?.venues)");
    expect(page).not.toContain("const second = measured[1]");
    const md = readFileSync(join(import.meta.dir, "markdown-views.ts"), "utf8");
    expect(md).toContain("perpVolumeLead(cohort.venues)");
    expect(md).not.toContain("const lead = dex[0];");
  });
});

describe("the cohort total excludes what the ranking excludes", () => {
  /**
   * #3090 kept the house-LP venue out of the leader sentence and left it
   * inside the sum. On 2026-10-21 production served "Cohort volume 30d
   * $2929.17B" while the Markdown view's row 1 was Papertrade at $2626.83B:
   * 90 percent of the card, 5.2 times the $502B the other venues add up to,
   * under a headline naming a different leader. A reader could not reconcile
   * the leader's volume with the cohort it supposedly leads.
   *
   * Open interest is the opposite call and stays whole. Turnover on a house
   * LP at up to 1000x with no fees is not the cohort's quantity, but a
   * snapshot of open positions is the same measurement everywhere, and that
   * venue's $480.9M was 2.4 percent of the $19.73B total, not 90.
   */
  test("the two counts differ, and each sentence takes the one it means", () => {
    const stats = readFileSync(join(import.meta.dir, "perp-stats.ts"), "utf8");
    // The sum skips the named set; the coverage count does not.
    expect(stats).toContain("if (!NOTIONAL_NOT_COMPARABLE.has(r.slug)) {");
    expect(stats).toContain("volumeRankedVenues += 1;");
    // Open interest is summed outside that guard.
    const loop = stats.slice(
      stats.indexOf("let volumeRankedVenues = 0;"),
      stats.indexOf("const fundingValues"),
    );
    expect(loop).toContain("if (r.openInterest != null) cohortOpenInterest += r.openInterest;");
    expect(
      loop.indexOf("cohortOpenInterest += r.openInterest"),
    ).toBeGreaterThan(loop.indexOf("volumeRankedVenues += 1;"));
  });

  test("every sentence about 30-day volume counts the ranked venues", () => {
    // trackedVenues is a coverage count and feeds the "N of M" card. Any
    // sentence that says "by 30-day volume" means the other one.
    const page = readFileSync(
      join(import.meta.dir, "..", "app", "perps", "page.tsx"),
      "utf8",
    );
    for (const m of page.matchAll(/[^`]{0,80}by 30-day volume/g)) {
      expect(m[0], `"${m[0].trim()}" must not count tracked venues`).not.toContain(
        "trackedVenues",
      );
    }
    expect(page).toContain("cohort?.totals.volumeRankedVenues");
    expect(page).not.toContain("${tracked} tracked perp DEXes on 30-day volume");
  });

  test("the Markdown view lists the excluded venue apart, not as row 1", () => {
    const md = readFileSync(join(import.meta.dir, "markdown-views.ts"), "utf8");
    // Answer engines fetch this view. Sorting the excluded row in put it at
    // position 1 under a headline naming someone else.
    expect(md).toContain("const dex = dexAll.filter((v) => !NOTIONAL_NOT_COMPARABLE.has(v.slug));");
    expect(md).toContain("## Measured, not ranked on volume");
    expect(md).toContain("cohort.totals.volumeRankedVenues");
  });
});
