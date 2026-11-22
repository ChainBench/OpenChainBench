import { describe, expect, test } from "bun:test";
import { SpecSchema } from "./spec-schema";
import { perpFeesSpecRaw } from "@/test/benchmark";

type RawSpec = {
  providers: { slug: string; venue_type?: string }[];
  fees_removed?: Record<string, unknown>;
  metric_panels?: Record<string, unknown>[];
  [key: string]: unknown;
};

const perpFees = (): RawSpec => perpFeesSpecRaw() as RawSpec;

const issuePaths = (raw: RawSpec): string[] => {
  const parsed = SpecSchema.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
};

describe("fees_removed validation", () => {
  test("the perp-fees spec is valid as written", () => {
    expect(issuePaths(perpFees())).toEqual([]);
  });

  test("a rename no provider reads is refused", () => {
    const raw = perpFees();
    raw.fees_removed = {
      ...raw.fees_removed,
      metric_rename: { perp_fees_total_bps: "perp_fees_spread_bps" },
    };

    expect(issuePaths(raw)).toEqual([
      "fees_removed.metric_rename.perp_fees_total_bps",
    ]);
  });

  test("a panel scoped to a fees view needs the view", () => {
    const raw = perpFees();
    delete raw.fees_removed;

    expect(issuePaths(raw)).toEqual([
      "metric_panels.0.fees",
      "metric_panels.1.fees",
      "metric_panels.2.fees",
      "metric_panels.3.fees",
    ]);
  });
});

describe("venue_type validation", () => {
  test("a row left untyped next to typed rows is refused", () => {
    const raw = perpFees();
    raw.providers = raw.providers.map((p, i) =>
      i === 3 ? { ...p, venue_type: undefined } : p,
    );

    expect(issuePaths(raw)).toEqual(["providers.3.venue_type"]);
  });
});
