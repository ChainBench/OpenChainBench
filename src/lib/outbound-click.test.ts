import { describe, expect, test } from "bun:test";
import { decideGo, outboundHref } from "@/lib/outbound-click";

type GoRequest = Parameters<typeof decideGo>[0];

const SELF = "openchainbench.com";
const DESTINATION = "https://www.quicknode.com/pricing?utm_source=openchainbench";

function request(overrides: Partial<GoRequest> = {}): GoRequest {
  return {
    to: DESTINATION,
    family: "browser",
    referer: `https://${SELF}/products/quicknode?tab=rpc`,
    selfHost: SELF,
    background: false,
    ...overrides,
  };
}

describe("decideGo", () => {
  test.each([
    ["missing", null],
    ["empty", ""],
    ["relative", "/about"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["ftp", "ftp://example.com/file"],
    ["credentials", "https://user:pass@example.com/"],
    ["username only", "https://openchainbench.com@example.com/"],
    ["password only", "https://:secret@example.com/"],
    ["protocol relative", "//evil.example"],
    ["backslashes", "\\\\evil.example"],
    ["line feed", "https://evil.example/\nset-cookie:a=b"],
    ["carriage return", "https://evil\r.example/"],
    ["tab in host", "https://ev\til.example/"],
    ["leading space", " https://evil.example/"],
    ["too long", `https://example.com/${"a".repeat(2048)}`],
    ["too long once encoded", `https://example.com/${"é".repeat(400)}`],
    ["our host", `https://${SELF}/rpc`],
    ["our www host", `https://www.${SELF}/rpc`],
    ["our subdomain", `https://kv.${SELF}/x`],
    ["our host with a trailing dot", `https://${SELF}./rpc`],
    ["our host on another port", `https://${SELF}:8443/rpc`],
    ["our subdomain on another port", `https://kv.${SELF}:444/x`],
    ["localhost", "http://localhost:8080/"],
    ["localhost with a trailing dot", "http://localhost./"],
    ["an IPv4 literal", "http://169.254.169.254/latest/meta-data/"],
    ["a decimal IPv4 literal", "http://2852039166/"],
    ["an IPv6 literal", "http://[::1]/"],
    ["a host over the DNS limit", `https://${"a.".repeat(127)}example/`],
  ])("rejects %s", (_name, to) => {
    expect(decideGo(request({ to })).kind).toBe("reject");
  });

  test("rejects a bad destination even on a background request", () => {
    const to = "javascript:alert(1)";
    expect(decideGo(request({ to, background: true })).kind).toBe("reject");
  });

  test("accepts a plain http destination", () => {
    const decision = decideGo(request({ to: "http://example.com/" }));
    expect(decision.kind).toBe("redirect");
  });

  test("accepts a host that only ends with our name", () => {
    expect(decideGo(request({ to: `https://not${SELF}/` })).kind).toBe("redirect");
  });

  test("ignores a background request", () => {
    expect(decideGo(request({ background: true }))).toEqual({ kind: "background" });
  });

  test("redirects a non-browser without counting", () => {
    const decision = decideGo(request({ family: "googlebot", referer: null }));
    expect(decision).toEqual({
      kind: "redirect",
      destination: new URL(DESTINATION),
      click: null,
    });
  });

  test("counts a browser coming from one of our pages", () => {
    expect(decideGo(request())).toEqual({
      kind: "redirect",
      destination: new URL(DESTINATION),
      click: { href: DESTINATION, host: "www.quicknode.com", page: "/products/quicknode", via: "go" },
    });
  });

  test("caps the page taken from the referer", () => {
    const path = `/${"a".repeat(1000)}`;
    const referer = `https://${SELF}${path}`;
    const decision = decideGo(request({ referer }));
    if (decision.kind !== "redirect") throw new Error(decision.kind);
    expect(decision.click?.page.length).toBeLessThan(path.length);
  });

  test("treats www and the apex as the same site for the referer", () => {
    const decision = decideGo(request({ referer: `https://www.${SELF}/rpc` }));
    expect(decision.kind).toBe("redirect");
  });

  test.each([
    ["absent", null],
    ["unparseable", "not a url"],
    ["foreign", "https://mail.example/inbox"],
    ["a lookalike suffix", `https://${SELF}.evil.example/rpc`],
    ["a lookalike prefix", `https://not${SELF}/rpc`],
    ["our subdomain", `https://kv.${SELF}/rpc`],
    ["our host on another scheme", `android-app://${SELF}/rpc`],
    ["too long to parse", `https://${SELF}/${"a".repeat(3000)}`],
  ])("asks for confirmation when the referer is %s", (_name, referer) => {
    expect(decideGo(request({ referer }))).toEqual({
      kind: "confirm",
      destination: new URL(DESTINATION),
      click: { href: DESTINATION, host: "www.quicknode.com", page: "", via: "confirm" },
    });
  });
});

describe("outboundHref", () => {
  function destinationOf(link: string): string | null {
    return new URL(link, `https://${SELF}`).searchParams.get("to");
  }

  test("routes a third-party link through /go with its utm tag", () => {
    expect(outboundHref("https://drpc.org/a?b=c&d=e#top")).toBe(
      "/go?to=https%3A%2F%2Fdrpc.org%2Fa%3Fb%3Dc%26d%3De%26utm_source%3Dopenchainbench%23top",
    );
  });

  test("keeps a referral code and an existing campaign", () => {
    const link = outboundHref("https://example.com/?ref=ocb&utm_source=campaign");
    expect(destinationOf(link)).toBe("https://example.com/?ref=ocb&utm_source=campaign");
  });

  test.each([
    "https://openchainbench.com/rpc",
    "https://video.openchainbench.com/v/a.mp4",
    "https://doi.org/10.1000/182",
    "https://www.doi.org/10.1000/182",
    "https://creativecommons.org/licenses/by/4.0/",
    "mailto:hello@example.com",
    "cursor://anysphere.cursor-deeplink/mcp/install",
    "vscode:mcp/install",
    "/about",
    "#methodology",
    "not a url",
  ])("leaves %s unchanged", (href) => {
    expect(outboundHref(href)).toBe(href);
  });

  test("does not send a link with credentials through /go", () => {
    expect(outboundHref("https://user:pass@example.com/")).toBe(
      "https://user:pass@example.com/?utm_source=openchainbench",
    );
  });

  test.each([undefined, ""])("renders %s as an empty href", (href) => {
    expect(outboundHref(href)).toBe("");
  });

  test("leaves a link too long for /go unchanged", () => {
    const long = `https://example.com/?utm_source=x&a=${"a".repeat(2048)}`;
    expect(outboundHref(long)).toBe(long);
  });

  test.each([
    "https://example.com/a b?utm_source=campaign",
    "https://example.com/é?q=日本語",
  ])("produces a link /go accepts for %s", (href) => {
    const to = destinationOf(outboundHref(href));
    expect(decideGo(request({ to })).kind).toBe("redirect");
  });
});
