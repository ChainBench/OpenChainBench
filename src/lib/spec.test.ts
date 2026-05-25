import { describe, expect, test } from "bun:test";
import { injectLabels } from "./spec";

describe("injectLabels", () => {
  test("injects into an empty selector", () => {
    expect(injectLabels("metric{}", { job: "api" })).toBe(`metric{job="api"}`);
  });

  test("appends to an existing selector without duplicating commas", () => {
    expect(
      injectLabels(`metric{region="us"}`, { job: "api" }),
    ).toBe(`metric{region="us",job="api"}`);
  });

  test("does not duplicate a label that's already present", () => {
    expect(
      injectLabels(`metric{job="old"}`, { job: "new" }),
    ).toBe(`metric{job="old"}`);
  });

  test("applies to every selector in a multi-metric query", () => {
    const q = `rate(metric_a{}[5m]) + rate(metric_b{tier="free"}[5m])`;
    const out = injectLabels(q, { region: "eu" });
    expect(out).toContain(`metric_a{region="eu"}`);
    expect(out).toContain(`metric_b{tier="free",region="eu"}`);
  });

  test("escapes double-quotes in label values", () => {
    expect(injectLabels(`m{}`, { tag: `quo"te` })).toBe(`m{tag="quo\\"te"}`);
  });

  test("escapes backslashes in label values", () => {
    expect(injectLabels(`m{}`, { p: `a\\b` })).toBe(`m{p="a\\\\b"}`);
  });

  test("strips newlines from label values to prevent selector breakout", () => {
    expect(injectLabels(`m{}`, { p: "foo\nbar" })).toBe(`m{p="foobar"}`);
  });

  test("no-op when labels object is empty", () => {
    expect(injectLabels(`metric{job="api"}`, {})).toBe(`metric{job="api"}`);
  });

  test("returns query unchanged when there's no selector at all", () => {
    expect(injectLabels("time()", { job: "api" })).toBe("time()");
  });
});
