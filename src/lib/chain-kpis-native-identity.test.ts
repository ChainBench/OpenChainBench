import { expect, test } from "bun:test";
import { stubPrometheus } from "@/test/prometheus-stub";
import { fetchChainKpisFresh } from "./chain-kpis";
import { withNativePricePolicy } from "./chain-native-pricing";

let identified = false;
let queries: string[] = [];
stubPrometheus((query) => {
  queries.push(query);
  const native = query.startsWith("chain_native_");
  const matching = query.includes('asset_id="100004858"');
  const legacy = native && !matching;
  const mcap = query.startsWith("chain_native_mcap_");
  const value = legacy ? 2500 : native ? (mcap ? 23000000 : 0.25) : 123;
  if (native && matching && !identified) return [];
  return [{ metric: {}, value: [1, String(value)] }];
});

for (const withIdentity of [false, true]) {
  test(`fresh snapshot reads only matching asset series (identified=${withIdentity})`, async () => {
    identified = withIdentity;
    queries = [];
    const fresh = await fetchChainKpisFresh("fraxtal");
    expect(queries).toContain('chain_native_price_usd{chain="fraxtal",asset_id="100004858"}');
    expect(queries).toContain('chain_native_mcap_usd{chain="fraxtal",asset_id="100004858"}');
    expect(fresh?.nativePrice).toBe(identified ? 0.25 : null);
    expect(fresh?.nativeMcap).toBe(identified ? 23000000 : null);
    expect(fresh?.tvl).toBe(123);
    expect(fresh?.nativePriceAssetId).toBe(100004858);
    const snapshot = JSON.parse(JSON.stringify(fresh));
    expect(withNativePricePolicy(snapshot).nativePrice).toBe(identified ? 0.25 : null);
  });
}
