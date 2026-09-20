import { describe, expect, test } from "bun:test";
import { Budget, POSTHOG_ORG_LIMIT_PER_HOUR, readBudgetLimit } from "../lib/posthog";

describe("budget", () => {
  test("limit from env, clamped to PostHog's organisation limit", () => {
    expect(readBudgetLimit(undefined)).toBe(300);
    expect(readBudgetLimit("abc")).toBe(300);
    expect(readBudgetLimit("50")).toBe(50);
    expect(readBudgetLimit("0")).toBe(1);
    expect(readBudgetLimit("99999")).toBe(POSTHOG_ORG_LIMIT_PER_HOUR);
  });
  test("frees slots after an hour", () => {
    const budget = new Budget(3);
    const t0 = 1_000_000_000;
    expect(budget.waitMs(t0)).toBe(0);
    budget.spend(t0);
    budget.spend(t0 + 1);
    budget.spend(t0 + 2);
    expect(budget.used(t0 + 3)).toBe(3);
    expect(budget.waitMs(t0 + 3)).toBe(3_600_000 - 3);
    expect(budget.waitMs(t0 + 3_600_000)).toBe(0);
    expect(budget.used(t0 + 3_600_001)).toBe(1);
  });
});
