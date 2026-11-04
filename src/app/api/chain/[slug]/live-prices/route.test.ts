import { expect, spyOn, test } from "bun:test";
import { GET } from "./route";

test("Fraxtal returns unavailable FRAX values without querying a different asset", async () => {
  const oldKey = process.env.MOBULA_API_KEY;
  process.env.MOBULA_API_KEY = "offline-test-key";
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected upstream request"),
  );
  try {
    const response = await GET(new Request("https://example.test/api/chain/fraxtal/live-prices"), {
      params: Promise.resolve({ slug: "fraxtal" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      symbol: "FRAX", price: null, marketCap: null, volume24h: null, ts: expect.any(Number),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    if (oldKey === undefined) delete process.env.MOBULA_API_KEY;
    else process.env.MOBULA_API_KEY = oldKey;
  }
});
