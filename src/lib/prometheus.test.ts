import { describe, expect, test } from "bun:test";
import { Prometheus, extractMetricName, trimScalar } from "./prometheus";

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

describe("trimScalar", () => {
  // The case that exposed this. hl_frontend_biggest_day_unix_v2 for fomo was
  // 1791244800, midnight UTC on 2026-10-06. Rounded to six significant
  // digits it becomes 1791240000, which is 22:40 on the 5th, and the
  // "Biggest complete day" card said 2026-10-05 for a day that ended on the
  // 6th. The previous value rounded by 20 minutes and stayed inside its own
  // date, which is why the bug sat there unnoticed.
  test("keeps a unix second exact", () => {
    expect(trimScalar(1791244800)).toBe(1791244800);
    const iso = new Date(1791244800 * 1000).toISOString().slice(0, 10);
    expect(iso).toBe("2026-10-06");
  });

  test("keeps any integer exact", () => {
    expect(trimScalar(53017)).toBe(53017);
    expect(trimScalar(192499360)).toBe(192499360);
    expect(trimScalar(-1)).toBe(-1);
  });

  // The rounding exists to stop full-precision float tails bloating the
  // cached Benchmark objects, and that still applies to anything that is not
  // a whole number.
  test("still trims a float tail", () => {
    expect(trimScalar(93131.21526500066)).toBe(93131.2);
    expect(trimScalar(0.19919808618886373)).toBe(0.199198);
  });

  test("passes zero and refuses non-finite", () => {
    expect(trimScalar(0)).toBe(0);
    expect(trimScalar(Number.NaN)).toBeNull();
    expect(trimScalar(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("dataAgesSec", () => {
  test("one query for every metric, keyed back by name", async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(new URL(String(input)).searchParams.get("query") ?? "");
      return Response.json({
        status: "success",
        data: {
          resultType: "vector",
          result: [
            { metric: { m: "a_ms" }, value: [1, "12.5"] },
            { metric: { m: "b_ms" }, value: [1, "NaN"] },
          ],
        },
      });
    }) as typeof fetch;
    try {
      const ages = await new Prometheus("http://localhost:9090").dataAgesSec([
        "a_ms",
        "b_ms",
        "a_ms",
        'bad"name',
      ]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe('label_replace(time() - max(timestamp(a_ms)), "m", "a_ms", "", "") or label_replace(time() - max(timestamp(b_ms)), "m", "b_ms", "", "")');
      expect([...ages]).toEqual([["a_ms", 12.5]]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
