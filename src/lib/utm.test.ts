import { describe, expect, test } from "bun:test";
import { UTM_SOURCE, withUtm } from "@/lib/utm";
import { getProviderRegistry } from "@/data/provider-registry";

describe("withUtm", () => {
  test("tags a third-party destination", () => {
    expect(withUtm("https://drpc.org")).toBe(`https://drpc.org/?utm_source=${UTM_SOURCE}`);
    expect(withUtm("https://github.com/ChainBench/OpenChainBench")).toBe(
      `https://github.com/ChainBench/OpenChainBench?utm_source=${UTM_SOURCE}`,
    );
  });

  test("keeps an existing query string and appends", () => {
    expect(withUtm("https://github.com/x/y/issues/new?template=a.yml")).toBe(
      `https://github.com/x/y/issues/new?template=a.yml&utm_source=${UTM_SOURCE}`,
    );
  });

  test("leaves our own site alone, subdomains included", () => {
    // Tagging an internal link starts a new campaign mid-visit and breaks
    // session attribution in PostHog.
    for (const u of [
      "https://openchainbench.com/rpc",
      "https://www.openchainbench.com/rpc",
      "https://staging.openchainbench.com/rpc",
      "https://kv.openchainbench.com/x",
    ]) {
      expect(withUtm(u)).toBe(u);
    }
  });

  test("leaves anything that is not http(s) alone", () => {
    for (const u of ["mailto:hello@openchainbench.com", "tel:+33", "#section", "/rpc", "../x"]) {
      expect(withUtm(u)).toBe(u);
    }
  });

  test("leaves identifiers alone: they are cited verbatim and appear in JSON-LD", () => {
    for (const u of ["https://doi.org/10.5281/zenodo.20800312", "https://creativecommons.org/licenses/by/4.0/"]) {
      expect(withUtm(u)).toBe(u);
    }
  });

  test("does not overwrite a hand-written campaign", () => {
    const u = "https://drpc.org/?utm_source=newsletter";
    expect(withUtm(u)).toBe(u);
  });

  test("empty and nullish are safe", () => {
    expect(withUtm("")).toBe("");
    expect(withUtm(null)).toBe("");
    expect(withUtm(undefined)).toBe("");
  });
});

// A provider's referral link replaces only the clicked href, and keeps both
// its own code and our utm_source; the canonical url stays clean.
describe("referral links", () => {
  test("blockmachine's href carries its referral code and our utm_source", () => {
    const reg = getProviderRegistry("blockmachine");
    expect(reg?.url).toBe("https://blockmachine.io");
    const href = new URL(withUtm(reg?.referralUrl || reg?.url));
    expect(href.searchParams.get("referral")).toBe("openchainbench");
    expect(href.searchParams.get("utm_source")).toBe("openchainbench");
  });

  test("referral providers keep a clean canonical url and a tagged referral href", () => {
    for (const [slug, canonical, param] of [
      ["quicknode", "https://www.quicknode.com", ["via", "florent"]],
      ["chainstack", "https://chainstack.com", null],
      ["fomo", "https://fomo.family", null],
      ["pump-fun", "https://pump.fun", null],
      ["gains", "https://gains.trade", ["ref", "openchainbench"]],
    ] as const) {
      const reg = getProviderRegistry(slug);
      expect(reg?.url).toBe(canonical);
      const href = new URL(withUtm(reg?.referralUrl || reg?.url));
      expect(reg?.referralUrl).toBeTruthy();
      expect(href.origin + href.pathname).not.toBe(new URL(canonical).origin + new URL(canonical).pathname);
      expect(href.searchParams.get("utm_source")).toBe("openchainbench");
      if (param) expect(href.searchParams.get(param[0])).toBe(param[1]);
    }
  });
});
