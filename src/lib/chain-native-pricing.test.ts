import { describe, expect, test } from "bun:test";
import { CHAIN_BY_SLUG } from "@/lib/chains";
import { nativePricingSymbol, withNativePricePolicy } from "./chain-native-pricing";

describe("native asset pricing policy", () => {
  test("Fraxtal does not resolve FRAX through a symbol-only price lookup", () => {
    expect(nativePricingSymbol(CHAIN_BY_SLUG.get("fraxtal")!)).toBeNull();
  });

  test("old frxETH snapshot values cannot be relabelled as native FRAX", () => {
    const snapshot = {
      slug: "fraxtal", nativePrice: 2500, nativeMcap: 1000000,
      tvl: 123, dexVolume24h: 456, fees30d: 7,
    };
    expect(withNativePricePolicy(snapshot)).toEqual({
      ...snapshot, nativePrice: null, nativeMcap: null,
    });
    expect(snapshot.nativePrice).toBe(2500);
  });

  test("other chains retain their current pricing and snapshot values", () => {
    expect(nativePricingSymbol(CHAIN_BY_SLUG.get("ethereum")!)).toBe("ETH");
    const snapshot = { slug: "ethereum", nativePrice: 2500, nativeMcap: 1000000 };
    expect(withNativePricePolicy(snapshot)).toBe(snapshot);
  });

  test("a provider alias is separate from the displayed native symbol", () => {
    const chain = { ...CHAIN_BY_SLUG.get("ethereum")!, nativePriceSymbol: "provider-id" };
    expect(nativePricingSymbol(chain)).toBe("provider-id");
    expect(chain.nativeSymbol).toBe("ETH");
  });
});
