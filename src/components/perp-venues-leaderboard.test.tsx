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

const row: PerpVenueRow = {
  ...unstamped,
  figureAgeSec: {
    volume24h: 30,
    volume30d: 30,
    openInterest: 300,
    fees30d: 7 * 86_400,
    activeMarkets: 2 * 3_600,
  },
};

const render = (rows: PerpVenueRow[]) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PerpVenuesLeaderboard rows={rows} />
    </AppRouterContext.Provider>,
  );

describe("PerpVenuesLeaderboard figure ages", () => {
  test("each figure shows its own age", () => {
    const html = render([row]);
    expect(html).toContain(">7d stale<");
    expect(html).toContain(">2h stale<");
    expect(html.match(/>5m behind</g)).toHaveLength(2);
    expect(html).not.toContain(">0m behind<");
  });

  test("a snapshot without ages renders no badge", () => {
    const html = render([unstamped]);
    expect(html).not.toMatch(/ (behind|stale)</);
  });
});
