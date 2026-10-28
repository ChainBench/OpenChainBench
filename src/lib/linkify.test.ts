import { describe, expect, it } from "bun:test";
import { linkifyParts } from "@/lib/linkify";

describe("linkifyParts", () => {
  // The sentence that prompted this: a credit that was never a link.
  it("pulls the URL out of a methodology bullet", () => {
    const parts = linkifyParts(
      "Source: the public tehcscreener API (https://tehcscreener.com/api), Allium-backed, no key.",
    );
    const links = parts.filter((p) => p.kind === "link");
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      kind: "link",
      href: "https://tehcscreener.com/api",
      label: "tehcscreener.com/api",
    });
    // the closing bracket and comma belong to the sentence
    expect(parts.map((p) => (p.kind === "text" ? p.value : "")).join("")).toContain("), Allium-backed");
  });

  it("leaves prose with no URL untouched", () => {
    const s = "Cadence: every 60 seconds per provider, from each of three regions.";
    expect(linkifyParts(s)).toEqual([{ kind: "text", value: s }]);
  });

  it("handles several URLs in one bullet", () => {
    const parts = linkifyParts("Reads https://a.example/x then https://b.example.");
    const links = parts.filter((p) => p.kind === "link");
    expect(links.map((l) => (l.kind === "link" ? l.href : ""))).toEqual([
      "https://a.example/x",
      "https://b.example",
    ]);
  });

  // http:// and javascript: are not matched at all, so a spec cannot smuggle
  // a scheme past the renderer. Specs are reviewed, but a parser that only
  // admits https is one less thing the review has to catch.
  it("matches https only", () => {
    const s = 'See http://plain.example and javascript:alert(1) and data:text/html,x';
    expect(linkifyParts(s).every((p) => p.kind === "text")).toBe(true);
  });

  // The href keeps the URL exactly as the spec wrote it, trailing slash and
  // all. Rewriting someone's URL to make a label prettier is how a credit
  // ends up pointing somewhere its owner did not choose. Only the visible
  // label is cleaned.
  it("cleans the label without touching the href", () => {
    const parts = linkifyParts("At https://tehcscreener.com/ today.");
    const link = parts.find((p) => p.kind === "link");
    expect(link).toEqual({
      kind: "link",
      href: "https://tehcscreener.com/",
      label: "tehcscreener.com",
    });
  });

  it("round-trips the original text", () => {
    const s = "Source: the public tehcscreener API (https://tehcscreener.com/api), no key.";
    const rebuilt = linkifyParts(s)
      .map((p) => (p.kind === "link" ? p.href : p.value))
      .join("");
    expect(rebuilt).toBe(s);
  });
});
