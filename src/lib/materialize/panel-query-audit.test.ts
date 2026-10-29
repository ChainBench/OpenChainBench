import { describe, expect, it } from "bun:test";

import { injectLabels, panelMetricQuery } from "@/lib/materialize/load";

/**
 * Dimension injection only reaches a query through a `{...}` group, and the
 * two paths that feed it do not agree about what to do when there is none.
 *
 * `panelMetricQuery` normalises a bare metric name to the braced form, so
 * `metric` becomes `metric{}` and then `metric{chain="..."}`. Provider
 * queries go straight to `injectLabels` through `applyDimensionsToSpec` with
 * no such normalisation.
 *
 * The consequence is sharp and silent in both directions: an EXPRESSION panel
 * with no brace gets `{}` appended to the whole string and the selector lands
 * on the last token, while a provider query with no brace is simply never
 * filtered and publishes the same pooled figure on every tab.
 *
 * Both were found auditing bench 310, and this file lives with the loader
 * rather than with that bench because the next victim will be a different
 * one. `panelMetricQuery` already has one such scar in its own doc comment:
 * every chain tab of bench 001's "First to report" view published the same
 * cross-chain average.
 */
describe("panelMetricQuery, the panel path", () => {
  const labels = { chain: "ethereum" };

  it("corrupts an expression that carries no selector", () => {
    const broken = "(time() - max by (provider) (rpc_api_last_probe_timestamp)) / 3600";
    const out = panelMetricQuery({ metric: broken }, labels);
    expect(out).toBe(
      '(time() - max by (provider) (rpc_api_last_probe_timestamp)) / 3600{chain="ethereum"}',
    );
    expect(out).not.toContain('rpc_api_last_probe_timestamp{chain="ethereum"}');
  });

  it("injects correctly once the series carries empty braces", () => {
    const fixed = "(time() - max by (provider) (rpc_api_last_probe_timestamp{})) / 3600";
    expect(panelMetricQuery({ metric: fixed }, labels)).toBe(
      '(time() - max by (provider) (rpc_api_last_probe_timestamp{chain="ethereum"})) / 3600',
    );
  });

  it("leaves an expression that already selects alone, adding only the dimension", () => {
    const ok = '100 * avg by (provider) (rpc_api_supported{api="trace_block"})';
    expect(panelMetricQuery({ metric: ok }, labels)).toBe(
      '100 * avg by (provider) (rpc_api_supported{api="trace_block",chain="ethereum"})',
    );
  });

  it("honours ignore_dimensions so a metric without the label is left bare", () => {
    const ok = '100 * avg by (provider) (rpc_api_supported{api="trace_block"})';
    expect(
      panelMetricQuery({ metric: ok, ignore_dimensions: ["chain"] }, labels),
    ).toBe(ok);
  });

  it("injects into EVERY selector of a two-operand expression, not just the first", () => {
    const ratio =
      'sum by (provider) (rpc_api_supported{api="a"}) / count by (provider) (rpc_api_supported{api="a"})';
    const out = panelMetricQuery({ metric: ratio }, labels);
    expect(out.match(/chain="ethereum"/g)).toHaveLength(2);
  });

  it("filters only the braced operand when one side has no selector", () => {
    // The asymmetric case: numerator filtered, denominator pooled across every
    // chain, so the ratio silently compares one tab against all tabs.
    const mixed = 'sum by (provider) (rpc_api_supported{api="a"}) / count by (provider) (rpc_api_supported)';
    const out = panelMetricQuery({ metric: mixed }, labels);
    expect(out.match(/chain="ethereum"/g)).toHaveLength(1);
    expect(out).toContain("count by (provider) (rpc_api_supported)");
  });

  it("leaves a range or subquery selector untouched, since those use brackets", () => {
    const sub = "max_over_time(rate(rpc_api_probe_total{api=\"a\"}[5m])[1h:1m])";
    const out = panelMetricQuery({ metric: sub }, labels);
    expect(out).toContain('rpc_api_probe_total{api="a",chain="ethereum"}');
    expect(out).toContain("[5m]");
    expect(out).toContain("[1h:1m]");
  });
});

describe("injectLabels, the provider-query path", () => {
  const labels = { chain: "ethereum" };

  it("does NOTHING to a query with no brace, so the figure is never filtered", () => {
    // This is bench 310's headline as first written. It has no selector
    // anywhere, so every chain tab would publish the same pooled ratio.
    const headline =
      "100 * sum by (provider) (rpc_api_supported) / count by (provider) (rpc_api_supported)";
    expect(injectLabels(headline, labels)).toBe(headline);
  });

  it("filters the same query once each series carries braces", () => {
    const fixed =
      "100 * sum by (provider) (rpc_api_supported{}) / count by (provider) (rpc_api_supported{})";
    const out = injectLabels(fixed, labels);
    expect(out.match(/chain="ethereum"/g)).toHaveLength(2);
  });

  it("adds the dimension beside a pinned provider rather than opening a second group", () => {
    const pinned = 'avg(rpc_api_supported{provider="quicknode"})';
    expect(injectLabels(pinned, labels)).toBe(
      'avg(rpc_api_supported{provider="quicknode",chain="ethereum"})',
    );
  });

  it("replaces a selector pinned to the dimension's all value instead of contradicting it", () => {
    const pooled = 'avg(rpc_api_supported{chain="all"})';
    expect(injectLabels(pooled, labels)).toBe(
      'avg(rpc_api_supported{chain="ethereum"})',
    );
  });

  /**
   * The presence test is `\bchain\s*=`, so it reads a REGEX matcher as "the
   * dimension is already pinned here" and declines to add the tab's own
   * filter, while a negative matcher is invisible to it and composes.
   *
   * That asymmetry inverts which shape is safe. Scoping a bench to the
   * chains it covers with an allow-list looks more robust than excluding one
   * chain by name, because it also excludes whatever the harness adds next.
   * It is the shape that silently disables every chain tab: all eight would
   * publish the all-chains figure. Found while choosing between the two for
   * bench 311, whose harness emits one Solana cell for a future bench.
   *
   * This pins today's behaviour rather than endorsing it. If injectLabels
   * ever learns to compose with a regex matcher, this test is meant to fail
   * so the change is deliberate: update it, and then the specs that worked
   * around the trap can drop the workaround.
   */
  it("a regex matcher suppresses the dimension filter, a negative matcher does not", () => {
    const allowList = 'avg(rpc_api_supported{chain=~"ethereum|base"})';
    expect(injectLabels(allowList, labels)).toBe(allowList);
    expect(injectLabels(allowList, labels)).not.toContain('chain="ethereum"');

    const exclusion = 'avg(rpc_api_supported{chain!="solana"})';
    expect(injectLabels(exclusion, labels)).toBe(
      'avg(rpc_api_supported{chain!="solana",chain="ethereum"})',
    );
  });

  it("the same asymmetry reaches the panel path, which shares injectLabels", () => {
    const allowList =
      '100 * avg by (provider) (rpc_api_supported{chain=~"ethereum|base"})';
    expect(panelMetricQuery({ metric: allowList }, labels)).toBe(allowList);

    const exclusion =
      '100 * avg by (provider) (rpc_api_supported{chain!="solana"})';
    expect(panelMetricQuery({ metric: exclusion }, labels)).toBe(
      '100 * avg by (provider) (rpc_api_supported{chain!="solana",chain="ethereum"})',
    );
  });
});
