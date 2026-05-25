import { describe, expect, test } from "bun:test";
import { extractMetricName } from "./prometheus";

describe("extractMetricName", () => {
  test("plain metric with label selector", () => {
    expect(extractMetricName(`http_requests{job="api"}`)).toBe("http_requests");
  });

  test("metric inside a range vector", () => {
    expect(extractMetricName("rate(http_requests[5m])")).toBe("http_requests");
  });

  test("skips aggregation and rate keywords", () => {
    expect(
      extractMetricName("sum(rate(http_requests_total[5m]))"),
    ).toBe("http_requests_total");
  });

  test("handles colon-separated recording rule names", () => {
    expect(
      extractMetricName(`job:request_latency:p99{job="api"}`),
    ).toBe("job:request_latency:p99");
  });

  test("returns null for a query with no real metric reference", () => {
    expect(extractMetricName("scalar(time())")).toBeNull();
  });

  test("ignores reserved keywords even when they have a selector", () => {
    expect(
      extractMetricName(`count by (job) (metric{}) > 0`),
    ).toBe("metric");
  });

  test("rejects identifiers that start with a digit", () => {
    expect(extractMetricName("5xx_responses")).toBeNull();
  });
});
