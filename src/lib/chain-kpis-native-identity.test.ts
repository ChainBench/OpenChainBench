import { afterEach, expect, test } from "bun:test";
import { fetchChainKpisFresh } from "./chain-kpis";
import { withNativePricePolicy } from "./chain-native-pricing";

const realFetch = globalThis.fetch;
const oldProm = process.env.PROMETHEUS_URL;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (oldProm === undefined) delete process.env.PROMETHEUS_URL;
  else process.env.PROMETHEUS_URL = oldProm;
});

for (const identified of [false, true]) {
  test(`fresh snapshot reads only matching asset series (identified=${identified})`, async () => {
    process.env.PROMETHEUS_URL = "http://localhost:9090";
    const queries: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const query = new URL(String(input)).searchParams.get("query")!;
      queries.push(query);
      const native = query.startsWith("chain_native_");
      const matching = query.includes('asset_id="100004858"');
      const legacy = native && !matching;
      const value = legacy ? 2500 : native ? query.startsWith("chain_native_mcap_") ? 23000000 : 0.25 : 123;
      const result = native && matching && !identified ? [] : [{ metric: {}, value: [1, String(value)] }];
      return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result } }));
    }) as typeof fetch;
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
