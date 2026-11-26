import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { PerpVenueRow } from "@/lib/perp-stats";
import { PerpVenuesLeaderboard } from "./perp-venues-leaderboard";

const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};

const unstamped: PerpVenueRow = {
  slug: "hyperliquid",
  name: "Hyperliquid",
  chain: "Hyperliquid L1",
  venueType: "onchain",
  volume24h: 1e9,
  volume30d: 3e10,
  openInterest: 1e9,
  fees30d: 5e7,
  activeMarkets: 200,
  topMarketVolume24h: null,
  health: 1,
  allInFeeBpsEth: null,
  funding24hBpsEth: null,
};

const DAY = 86_400;

const aged = (
  ages: PerpVenueRow["figureAgeSec"],
  extra: Partial<PerpVenueRow> = {},
): PerpVenueRow => ({ ...unstamped, ...extra, figureAgeSec: ages });

const render = (rows: PerpVenueRow[]) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PerpVenuesLeaderboard rows={rows} />
    </AppRouterContext.Provider>,
  );

const badges = (html: string) =>
  [...html.matchAll(/>([^<>]+ (?:behind|stale))</g)].map((m) => m[1]);

const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("PerpVenuesLeaderboard figure ages", () => {
  test("each figure shows its own age", () => {
    const volumeOlder = aged({
      volume24h: 7_200,
      volume30d: 120,
      openInterest: 119,
      fees30d: 599,
      activeMarkets: 600,
    });
    const oiOlder = aged(
      {
        volume24h: 30,
        volume30d: null,
        openInterest: 7 * DAY,
        fees30d: null,
        activeMarkets: null,
      },
      { slug: "gains", name: "Gains", volume30d: 1e9 },
    );
    const html = render([volumeOlder, oiOlder]);
    expect(badges(html)).toEqual([
      "2 min behind",
      "9 min behind",
      "2 hours stale",
      "10 min stale",
      "7 days stale",
      "7 days stale",
    ]);
    expect(text(html)).toContain("$30.00B 2 min behind");
    expect(text(html)).toContain("“behind” in amber from 2 min");
    expect(text(html)).toContain("“stale” in red from 10 min");
  });

  const day = {
    volume24h: DAY,
    volume30d: DAY,
    openInterest: DAY,
    fees30d: DAY,
    activeMarkets: DAY,
  };
  test.each([
    ["volume30d", 4],
    ["openInterest", 3],
    ["fees30d", 4],
    ["activeMarkets", 4],
    ["volume24h", 4],
  ] as const)("a missing %s shows no age", (field, shown) => {
    const html = render([aged(day, { [field]: null })]);
    expect(badges(html)).toEqual(Array(shown).fill("1 day stale"));
  });

  const freshAges = {
    volume24h: 60,
    volume30d: 60,
    openInterest: 60,
    fees30d: 60,
    activeMarkets: 60,
  };
  test.each([
    ["without ages", unstamped],
    ["with fresh ages", aged(freshAges)],
    [
      "with an old vol/OI input but no ratio",
      aged({ ...freshAges, volume24h: 600 }, { openInterest: 1e5 }),
    ],
  ])("a snapshot %s renders no badge or legend", (_, row) => {
    const html = render([row]);
    expect(badges(html)).toEqual([]);
    expect(text(html)).not.toContain("in red from");
  });
});
