import { afterEach, beforeEach, type Mock, spyOn } from "bun:test";
import { isolateEnv } from "./env";

export type PromSample = {
  metric: Record<string, string>;
  value: [number, string];
};

export function stubPrometheus(
  resultFor: (query: string) => PromSample[],
): void {
  isolateEnv(["PROMETHEUS_URL"]);
  let fetchSpy: Mock<typeof fetch> | null = null;
  beforeEach(() => {
    process.env.PROMETHEUS_URL = "http://localhost:9090";
    const answer = async (input: RequestInfo | URL) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      const data = { resultType: "vector", result: resultFor(query) };
      return new Response(JSON.stringify({ status: "success", data }));
    };
    const { preconnect } = globalThis.fetch;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(answer, { preconnect }),
    );
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
  });
}
