import { describe, expect, test } from "bun:test";
import { decideGo, type GoRequest, outboundHref } from "@/lib/outbound-click";

const SELF = "openchainbench.com";
const DESTINATION =
  "https://www.quicknode.com/pricing?utm_source=openchainbench";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";
const OLD_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1";
const OLD_CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.169 Mobile/15E148 Safari/604.1";
const WECHAT_X5 =
  "Mozilla/5.0 (Linux; Android 9; MI 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/6.2 TBS/045132 Mobile Safari/537.36 MicroMessenger/7.0.3";
const KAIOS =
  "Mozilla/5.0 (Mobile; Nokia_8110_4G; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5";
const LEGACY_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582";
const CHROME_76 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.100 Safari/537.36";
const FIREFOX_90 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0";

function request(overrides: Partial<GoRequest> = {}): GoRequest {
  return {
    to: DESTINATION,
    family: "browser",
    agent: CHROME,
    referer: `https://${SELF}/products/quicknode?tab=rpc`,
    fetchSite: "same-origin",
    confirmed: false,
    passed: false,
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
    const to = `https://not${SELF}/`;
    expect(decideGo(request({ to })).kind).toBe("redirect");
  });

  test("ignores a background request", () => {
    expect(decideGo(request({ background: true }))).toEqual({
      kind: "background",
    });
  });

  test("counts a browser coming from one of our pages", () => {
    expect(decideGo(request())).toEqual({
      kind: "redirect",
      destination: new URL(DESTINATION),
      click: {
        href: DESTINATION,
        host: "www.quicknode.com",
        page: "/products/quicknode",
        via: "go",
      },
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
    const req = request({ referer, fetchSite: null, agent: OLD_SAFARI });
    expect(decideGo(req)).toEqual({
      kind: "confirm",
      destination: new URL(DESTINATION),
      continueTo: "go",
      pass: "offer",
    });
  });

  test.each([
    ["Safari", OLD_SAFARI],
    ["Chrome on iOS", OLD_CHROME_IOS],
    ["WeChat engine", WECHAT_X5],
    ["KaiOS", KAIOS],
    ["Edge", LEGACY_EDGE],
  ])("counts an older %s from our page by its referer", (_name, agent) => {
    const decision = decideGo(request({ fetchSite: null, agent }));
    expect(decision).toMatchObject({
      kind: "redirect",
      click: { page: "/products/quicknode", via: "go" },
    });
  });

  test.each([
    ["Chrome", CHROME],
    ["Firefox", FIREFOX],
    ["the first Chrome to send it", CHROME_76],
    ["the first Firefox to send it", FIREFOX_90],
  ])("does not take the referer alone from %s", (_name, agent) => {
    const decision = decideGo(request({ fetchSite: null, agent }));
    expect(decision).toMatchObject({
      kind: "confirm",
      continueTo: "destination",
    });
  });

  test.each(["cross-site", "same-site", "none"])(
    "asks for confirmation for a %s request without our referer",
    (fetchSite) => {
      const decision = decideGo(request({ referer: null, fetchSite }));
      expect(decision).toMatchObject({ kind: "confirm", continueTo: "go" });
    },
  );

  test.each([
    ["cross-site", "none"],
    ["same-site", "none"],
    ["none", "offer"],
  ])("offers a pass to a %s request only when needed", (fetchSite, pass) => {
    const decision = decideGo(request({ referer: null, fetchSite }));
    expect(decision).toMatchObject({ kind: "confirm", pass });
  });

  test.each(["none", "cross-site"])(
    "sends a confirmed %s request without our page to the destination",
    (fetchSite) => {
      const decision = decideGo(
        request({ referer: null, fetchSite, confirmed: true }),
      );
      expect(decision).toMatchObject({
        kind: "confirm",
        continueTo: "destination",
        pass: "redeem",
      });
    },
  );

  test("counts a confirmed request whose pass was redeemed", () => {
    const decision = decideGo(
      request({
        referer: null,
        fetchSite: "none",
        confirmed: true,
        passed: true,
      }),
    );
    expect(decision).toMatchObject({
      kind: "redirect",
      click: { page: "", via: "confirm" },
    });
  });

  test("ignores a redeemed pass on a request that was not confirmed", () => {
    const decision = decideGo(
      request({ referer: null, fetchSite: "none", passed: true }),
    );
    expect(decision).toMatchObject({ kind: "confirm", pass: "offer" });
  });

  test("offers no pass to a client that is not a browser", () => {
    const decision = decideGo(request({ family: "declared-bot" }));
    expect(decision).toMatchObject({ kind: "confirm", pass: "none" });
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
    const tagged = "https://example.com/?ref=ocb&utm_source=campaign";
    expect(destinationOf(outboundHref(tagged))).toBe(tagged);
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
