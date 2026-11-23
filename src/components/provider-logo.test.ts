import { describe, expect, it } from "bun:test";
import { chipTreatmentFor } from "@/components/provider-logo";
import { logoPath, resolveLogoSlug } from "@/lib/logo-manifest";
import { LOGO_ALIASES_FOR_TEST } from "@/lib/logo-manifest";

/**
 * The invariant that was missing when "lighter-rh" shipped a near-black
 * mark on a dark board with nothing behind it: an alias renders the
 * target's FILE, so it must get the target's background.
 */
describe("chip treatment follows the file, not the slug", () => {
  it("gives an alias the same treatment as the slug it renders", () => {
    const wrong: string[] = [];
    for (const [alias, target] of Object.entries(LOGO_ALIASES_FOR_TEST)) {
      const a = chipTreatmentFor(alias);
      const t = chipTreatmentFor(target);
      if (a !== t) wrong.push(`${alias} -> ${target}: ${a} vs ${t}`);
    }
    expect(wrong).toEqual([]);
  });

  it("lighter-rh renders lighter's file and lighter's chip", () => {
    expect(resolveLogoSlug("lighter-rh")).toBe("lighter");
    expect(logoPath("lighter-rh")).toBe(logoPath("lighter"));
    expect(chipTreatmentFor("lighter-rh")).toBe("light");
  });

  it("aevo gets a light chip, its mark being a black disc on transparent", () => {
    expect(chipTreatmentFor("aevo")).toBe("light");
  });

  it("leaves a mark with its own fill alone", () => {
    expect(chipTreatmentFor("hyperliquid")).toBe("none");
  });
});
