import { describe, expect, test } from "bun:test";
import { dimensionLabels, panelMetricQuery } from "@/lib/materialize/load";

/**
 * A metric panel's query has to carry the reader's chain and region, and for a
 * long time one of the two paths that build it did not.
 *
 * Panel VALUES go through applyDimensionsToSpec, so they were always scoped.
 * Panel SERIES for 7d and 30d are stripped from the cache form and from the
 * snapshot on purpose and refetched by /api/series/[slug]?panel=..., which
 * rebuilds them from the raw spec on disk. That route injected only the
 * provider selector, so bench 001's "First to report" chart published one
 * cross-chain average under every chain tab: Codex 68.8% and Serialized 29.5%
 * identical on Base, BNB, Solana and Robinhood, while the head-lag view
 * beside it moved per chain because it goes through specToBenchmark.
 *
 * Nothing caught it because both paths hand-rolled the same string and only
 * one of them was ever read in a test. They share one function now, and this
 * asserts the property that was silently false.
 */
describe("panelMetricQuery", () => {
  test("a bare metric name gets the active dimensions", () => {
    expect(panelMetricQuery({ metric: "head_lag_first_share_pct" }, { chain: "base" }))
      .toBe('head_lag_first_share_pct{chain="base"}');
  });

  test("an empty selector is filled rather than left empty", () => {
    // This is the exact shape bench 001 declares, and the shape that made the
    // bug invisible: `{}` looks filtered and matches everything.
    expect(
      panelMetricQuery(
        { metric: "avg by (aggregator) (head_lag_first_share_pct{})" },
        { chain: "solana", region: "eu-west" },
      ),
    ).toBe(
      'avg by (aggregator) (head_lag_first_share_pct{chain="solana",region="eu-west"})',
    );
  });

  test("an existing selector keeps its matchers and gains the dimensions", () => {
    expect(
      panelMetricQuery({ metric: 'rpc_call_total{result="ok"}' }, { chain: "base" }),
    ).toBe('rpc_call_total{result="ok",chain="base"}');
  });

  test("a label the panel already pins is not duplicated", () => {
    expect(
      panelMetricQuery({ metric: 'head_lag_seconds{chain="bnb"}' }, { chain: "base" }),
    ).toBe('head_lag_seconds{chain="bnb"}');
  });

  test("ignore_dimensions drops the labels the metric does not carry", () => {
    // Appending a dimension a metric has no label for matches nothing and
    // empties the panel in silence (bench 282, blank on 71 of 75 views).
    expect(
      panelMetricQuery(
        { metric: "rpc_billing_units", ignore_dimensions: ["region"] },
        { chain: "base", region: "eu-west" },
      ),
    ).toBe('rpc_billing_units{chain="base"}');
  });

  test("no active filter leaves the metric queryable", () => {
    expect(panelMetricQuery({ metric: "head_lag_first_share_pct" }, {})).toBe(
      "head_lag_first_share_pct{}",
    );
  });

  test("the provider selector the route prepends survives the scoping", () => {
    // The route does scoped.replace("{", `{${sel},`), which only works
    // because panelMetricQuery always returns a braced form.
    const scoped = panelMetricQuery(
      { metric: "avg by (aggregator) (head_lag_first_share_pct{})" },
      { chain: "robinhood" },
    );
    expect(scoped.replace("{", '{aggregator="codex",')).toBe(
      'avg by (aggregator) (head_lag_first_share_pct{aggregator="codex",chain="robinhood"})',
    );
  });
});

describe("dimensionLabels", () => {
  test("tier is excluded because it selects the cohort, not a slice", () => {
    expect(dimensionLabels({ chain: "base", tier: "keyed" })).toEqual({ chain: "base" });
  });

  test('"all" is not a filter', () => {
    expect(dimensionLabels({ chain: "all", region: "sgp" })).toEqual({ region: "sgp" });
  });

  test("an empty filter set yields no labels", () => {
    expect(dimensionLabels({})).toEqual({});
  });
});
