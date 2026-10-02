import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY, type ProviderClaim } from "@/data/provider-registry";
import { claimAgeDays, claimAgeLabel, claimProblems, viewClaims } from "./provider-claims";

const ok: ProviderClaim = {
  label: "Swap insurance",
  value: "Swaps are covered by a third-party policy up to the notional amount.",
  source: "https://example.com/terms",
  verifiedAt: "2026-10-01",
};

describe("a claim must be sourced and dated to be published", () => {
  test("a well-formed claim has no problems", () => {
    expect(claimProblems("x", ok)).toEqual([]);
  });

  test("an unsourced claim is a rumour", () => {
    expect(claimProblems("x", { ...ok, source: "" })[0]).toContain("https URL");
    expect(claimProblems("x", { ...ok, source: "http://example.com" })[0]).toContain("https URL");
  });

  test("a claim without a readable date cannot be aged", () => {
    expect(claimProblems("x", { ...ok, verifiedAt: "last tuesday" })[0]).toContain("YYYY-MM-DD");
  });

  test("a future verification date is a typo, not a fresh check", () => {
    expect(claimProblems("x", { ...ok, verifiedAt: "2099-01-01" })[0]).toContain("future");
  });

  test("a superlative in a claim would be marketing we are laundering", () => {
    // The measured columns are where a provider gets to be fastest. This site
    // exists because marketing pages quote "real-time" without a number.
    const p = claimProblems("x", { ...ok, value: "The fastest settlement in the market." });
    expect(p[0]).toContain("superlative");
  });
});

describe("age and staleness", () => {
  const now = new Date("2026-10-02T12:00:00Z");

  test("counts whole days from the verification date", () => {
    expect(claimAgeDays("2026-10-02", now)).toBe(0);
    expect(claimAgeDays("2026-09-02", now)).toBe(30);
  });

  test("a future date yields no age rather than a negative one", () => {
    expect(claimAgeDays("2027-01-01", now)).toBeNull();
  });

  test("past six months a claim says so instead of ageing quietly", () => {
    const fresh = viewClaims([{ ...ok, verifiedAt: "2026-09-20" }], now)[0];
    const old = viewClaims([{ ...ok, verifiedAt: "2026-01-01" }], now)[0];
    expect(fresh.stale).toBe(false);
    expect(old.stale).toBe(true);
  });

  test("stale claims sort last, so the section opens on what we stand behind", () => {
    const views = viewClaims(
      [
        { ...ok, label: "Old", verifiedAt: "2025-01-01" },
        { ...ok, label: "New", verifiedAt: "2026-09-30" },
      ],
      now,
    );
    expect(views.map((v) => v.label)).toEqual(["New", "Old"]);
  });

  test("the age label reads like a person wrote it", () => {
    expect(claimAgeLabel(viewClaims([{ ...ok, verifiedAt: "2026-10-02" }], now)[0])).toBe("checked today");
    expect(claimAgeLabel(viewClaims([{ ...ok, verifiedAt: "2026-10-01" }], now)[0])).toBe("checked yesterday");
    expect(claimAgeLabel(viewClaims([{ ...ok, verifiedAt: "2026-09-22" }], now)[0])).toBe("checked 10 days ago");
    expect(claimAgeLabel(viewClaims([{ ...ok, verifiedAt: "2026-04-02" }], now)[0])).toContain("months ago");
  });

  test("no claims renders nothing rather than an empty section", () => {
    expect(viewClaims(undefined)).toEqual([]);
    expect(viewClaims([])).toEqual([]);
  });
});

describe("the registry itself", () => {
  test("every claim in the registry is publishable", () => {
    // This is the gate: a malformed claim fails the build rather than
    // reaching a page unsourced or undated.
    const problems = Object.entries(PROVIDER_REGISTRY).flatMap(([slug, entry]) =>
      (entry.claims ?? []).flatMap((c) => claimProblems(slug, c)),
    );
    expect(problems).toEqual([]);
  });
});
