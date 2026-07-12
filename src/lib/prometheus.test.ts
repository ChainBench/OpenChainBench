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

import { denseSeriesFromMatrix, type PromMatrix } from "./prometheus";

describe("denseSeriesFromMatrix", () => {
  // 7d window at 84 requested points: step = floor(604800/84) = 7200s,
  // grid = 85 slots (start + k*7200, both endpoints inclusive) — the
  // exact geometry of the aggregator-head-lag 7d fetch.
  const start = 1_760_000_000;
  const step = 7200;
  const end = start + 84 * step;
  const grid = (k: number) => start + k * step;

  function matrixWithHole(): PromMatrix[] {
    // Samples on every grid slot EXCEPT indices 30..39 (a ~20h outage
    // hole), mirroring what Prom returns when the harness was down.
    const values: [number, string][] = [];
    for (let k = 0; k <= 84; k++) {
      if (k >= 30 && k <= 39) continue;
      values.push([grid(k), String(k)]);
    }
    return [{ metric: {}, values }];
  }

  test("output length equals the dense grid even with a hole", () => {
    const out = denseSeriesFromMatrix(matrixWithHole(), start, end, step);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(85);
  });

  test("nulls sit exactly in the hole, values elsewhere", () => {
    const out = denseSeriesFromMatrix(matrixWithHole(), start, end, step)!;
    for (let k = 0; k <= 84; k++) {
      if (k >= 30 && k <= 39) expect(out[k]).toBeNull();
      else expect(out[k]).toBe(k);
    }
  });

  test("multi-series values are averaged per bucket", () => {
    const a: PromMatrix = { metric: { r: "a" }, values: [[grid(0), "10"], [grid(1), "20"]] };
    const b: PromMatrix = { metric: { r: "b" }, values: [[grid(0), "30"]] };
    const out = denseSeriesFromMatrix([a, b], start, end, step)!;
    expect(out[0]).toBe(20);
    expect(out[1]).toBe(20);
    expect(out[2]).toBeNull();
  });

  test("returns null when nothing maps onto the grid", () => {
    expect(denseSeriesFromMatrix([{ metric: {}, values: [] }], start, end, step)).toBeNull();
  });

  test("samples snap to the nearest grid slot; out-of-window dropped", () => {
    const m: PromMatrix[] = [
      {
        metric: {},
        values: [
          [grid(3) + step * 0.4, "1"], // snaps to slot 3
          [grid(5) + 0.5, "2"], // fractional-seconds start, snaps to slot 5
          [start - step, "9"], // before window
          [end + step, "9"], // after window
        ],
      },
    ];
    const out = denseSeriesFromMatrix(m, start, end, step)!;
    expect(out[3]).toBe(1);
    expect(out[5]).toBe(2);
    expect(out.length).toBe(85);
  });

  test("rounds to 6 significant digits", () => {
    const m: PromMatrix[] = [{ metric: {}, values: [[grid(0), "123.4567891"]] }];
    const out = denseSeriesFromMatrix(m, start, end, step)!;
    expect(out[0]).toBe(123.457);
  });
});
