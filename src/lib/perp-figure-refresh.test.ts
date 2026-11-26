import { afterEach, expect, setSystemTime, test } from "bun:test";
import { stubPrometheus, type PromSample } from "@/test/prometheus-stub";
import { fetchPerpCohortFresh } from "./perp-stats";

const NOW = 1_800_000_000;
const stamp = (venue: string, metric: string, ago: number): PromSample => ({
  metric: { venue, metric, instance: "perp-cohort-stats:2112" },
  value: [NOW, String(NOW - ago)],
});

const groupedBy = (query: string, s: PromSample): PromSample => {
  const by = /\bby \(([^)]*)\)/.exec(query)?.[1]?.split(/,\s*/);
  if (!by) return s;
  const kept = Object.entries(s.metric).filter(([k]) => by.includes(k));
  return { ...s, metric: Object.fromEntries(kept) };
};

const volume30d = (venue: string, name?: string): PromSample => ({
  metric: name ? { __name__: name, venue } : { venue },
  value: [NOW, "1"],
});

stubPrometheus((query) => {
  if (query.includes("perp_venue_metric_refresh_unix")) {
    return [
      stamp("hyperliquid", "volume_24h", 60),
      stamp("hyperliquid", "volume_30d", 2 * 86_400),
      stamp("hyperliquid", "oi", 90),
      stamp("hyperliquid", "fees_30d", 7 * 86_400),
      stamp("hyperliquid", "active_markets", 150),
      stamp("gains", "volume_30d", 3_600),
      stamp("gains", "volume_24h", 60),
      stamp("gains", "oi", -30),
    ].map((s) => groupedBy(query, s));
  }
  if (query.startsWith("perp_venue_volume_30d_usd or")) {
    return [
      volume30d("hyperliquid"),
      volume30d("gains", "perp_venue_volume_30d_usd"),
    ];
  }
  return [];
});

afterEach(() => {
  setSystemTime();
});

test("figure ages per venue", async () => {
  setSystemTime(new Date(NOW * 1000));
  const cohort = await fetchPerpCohortFresh();
  const row = (slug: string) => cohort?.venues.find((v) => v.slug === slug);
  expect(row("hyperliquid")?.figureAgeSec).toEqual({
    volume24h: 60,
    volume30d: 60,
    openInterest: 90,
    fees30d: 7 * 86_400,
    activeMarkets: 150,
  });
  expect(row("gains")?.figureAgeSec?.volume30d).toBe(3_600);
  expect(row("gains")?.figureAgeSec?.openInterest).toBe(0);
  expect(row("lighter")?.figureAgeSec).toBeUndefined();
});
