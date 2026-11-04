import { describe, expect, test } from "bun:test";
import { CHAIN_BY_SLUG } from "@/lib/chains";
import { mobulaMarketDataUrl, nativePriceMetricSelector, nativePriceQuery, nativePricingSymbol, withNativePricePolicy } from "./chain-native-pricing";

describe("native asset pricing policy", () => {
  test("Fraxtal does not resolve FRAX through a symbol-only price lookup", () => {
    expect(nativePricingSymbol(CHAIN_BY_SLUG.get("fraxtal")!)).toBeNull();
  });

  test("Fraxtal is priced by the Mobula asset id of FRAX (prev. FXS)", () => {
    const query = nativePriceQuery(CHAIN_BY_SLUG.get("fraxtal")!);
    expect(query).toBe("id=100004858");
    expect(mobulaMarketDataUrl(query!)).toBe("https://api.mobula.io/api/1/market/data?id=100004858");
  });

  test("an unidentified native cannot carry a snapshot value under its symbol", () => {
    const chain = { ...CHAIN_BY_SLUG.get("fraxtal")!, nativePriceAssetId: undefined };
    const snapshot = {
      slug: "fraxtal", nativePrice: 2500, nativeMcap: 1000000,
      tvl: 123, dexVolume24h: 456, fees30d: 7,
    };
    expect(withNativePricePolicy(snapshot, chain)).toEqual({
      ...snapshot, nativePrice: null, nativeMcap: null,
    });
    expect(snapshot.nativePrice).toBe(2500);
  });

  test("other chains retain their current pricing and snapshot values", () => {
    expect(nativePricingSymbol(CHAIN_BY_SLUG.get("ethereum")!)).toBe("ETH");
    expect(nativePriceQuery(CHAIN_BY_SLUG.get("ethereum")!)).toBe("symbol=ETH");
    const snapshot = { slug: "ethereum", nativePrice: 2500, nativeMcap: 1000000 };
    expect(withNativePricePolicy(snapshot)).toBe(snapshot);
  });

  test("a provider alias is separate from the displayed native symbol", () => {
    const chain = { ...CHAIN_BY_SLUG.get("ethereum")!, nativePriceSymbol: "provider-id" };
    expect(nativePricingSymbol(chain)).toBe("provider-id");
    expect(chain.nativeSymbol).toBe("ETH");
  });

  test("a pinned asset rejects an unversioned old snapshot without dropping DeFi KPIs", () => {
    const old = { slug: "fraxtal", nativePrice: 2500, nativeMcap: 1000000, tvl: 123, fees30d: 7 };
    expect(withNativePricePolicy(old)).toEqual({ ...old, nativePrice: null, nativeMcap: null });
    expect(old.nativePrice).toBe(2500);
  });

  test("a snapshot for a different asset id cannot carry the pinned native price", () => {
    const old = { slug: "fraxtal", nativePrice: 1, nativeMcap: 1000, nativePriceAssetId: 123 };
    expect(withNativePricePolicy(old)).toEqual({ ...old, nativePrice: null, nativeMcap: null });
  });

  test("a snapshot carrying the exact pinned asset id retains its native values", () => {
    const current = { slug: "fraxtal", nativePrice: 0.25, nativeMcap: 23000000, nativePriceAssetId: 100004858 };
    expect(withNativePricePolicy(current)).toBe(current);
  });

  test("pinned native metrics require the asset label, excluding legacy series", () => {
    expect(nativePriceMetricSelector("fraxtal")).toBe('{chain="fraxtal",asset_id="100004858"}');
    expect(nativePriceMetricSelector("ethereum")).toBe('{chain="ethereum"}');
  });

});
