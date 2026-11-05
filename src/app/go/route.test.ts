import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import * as analytics from "@/lib/analytics-server";

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0 Safari/537.36";
const ORIGIN = "https://openchainbench.com";
const OWN_PAGE = { referer: `${ORIGIN}/rpc` };
const DESTINATION = "https://www.quicknode.com/pricing";
const NOW = new Date("2026-11-05T12:00:00Z");
const TWO_SECONDS_LATER = new Date("2026-11-05T12:00:02Z");

const capture = mock<typeof analytics.captureServer>(() => {});
mock.module("@/lib/analytics-server", () => ({
  ...analytics,
  captureServer: capture,
}));
const { GET } = await import("./route");

let clients = 0;

function get(
  to: string | null,
  headers: Record<string, string> = {},
  method = "GET",
): Response {
  const query = to === null ? "" : `?to=${encodeURIComponent(to)}`;
  return GET(
    new Request(`${ORIGIN}/go${query}`, {
      method,
      headers: {
        "user-agent": BROWSER,
        "x-vercel-forwarded-for": `client-${clients}`,
        ...headers,
      },
    }),
  );
}

function capturedEvents(): unknown[] {
  return capture.mock.calls.map(([, event, props]) => ({ event, ...props }));
}

function exhaustClickCount(client: string): void {
  const headers = { ...OWN_PAGE, "x-vercel-forwarded-for": client };
  for (let i = 0; i < 1000; i += 1) {
    capture.mockClear();
    get(DESTINATION, headers);
    if (capture.mock.calls.length === 0) return;
  }
  throw new Error("the limit never stopped the count");
}

beforeEach(() => {
  clients += 1;
  capture.mockClear();
});

afterEach(() => {
  setSystemTime();
});

describe("GET /go", () => {
  test("redirects a click from one of our pages and counts it once", () => {
    const res = get(DESTINATION, {
      referer: `${ORIGIN}/products/quicknode`,
      "sec-fetch-dest": "document",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DESTINATION);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(capturedEvents()).toEqual([
      expect.objectContaining({ event: "outbound_click", via: "go" }),
    ]);
  });

  test("confirms and counts a foreign referer", async () => {
    const res = get(DESTINATION, { referer: "https://mail.example/inbox" });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain(`href="${DESTINATION}"`);
    expect(html).toContain("quicknode.com</a>");
    expect(html).not.toContain("www.quicknode.com<");
    expect(capturedEvents()).toEqual([
      expect.objectContaining({ event: "outbound_click", via: "confirm" }),
    ]);
  });

  test.each([
    ["path", `https://example.com/"><script>alert(1)</script>`],
    ["fragment", `https://example.com/#'onmouseover=alert(1)`],
    ["host", `https://a"onmouseover='alert(1)'.example/`],
  ])("escapes the destination %s when confirming", async (_name, to) => {
    const res = get(to);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/"onmouseover|'onmouseover|'alert/);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test("keeps the destination intact in the Continue link", async () => {
    const html = await get("https://example.com/it's?a=1&amp;b=2").text();
    expect(html).toContain(
      'href="https://example.com/it&apos;s?a=1&amp;amp;b=2"',
    );
  });

  test("names the whole host when it only starts like www", async () => {
    const html = await get("https://awww.example.com/").text();
    expect(html).toContain("Continue to awww.example.com</a>");
  });

  test("answers 400 without counting for an invalid destination", async () => {
    const res = get("javascript:alert(1)", OWN_PAGE);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain('<a href="/benchmarks"');
    expect(capture).not.toHaveBeenCalled();
  });

  test("redirects from a page on another deployment host", () => {
    const host = "https://staging.example";
    const to = encodeURIComponent(DESTINATION);
    const res = GET(
      new Request(`${host}/go?to=${to}`, {
        headers: { "user-agent": BROWSER, referer: `${host}/rpc` },
      }),
    );
    expect(res.status).toBe(302);
  });

  test("still redirects when counting fails", () => {
    capture.mockImplementationOnce(() => {
      throw new Error("capture failed");
    });
    expect(get(DESTINATION, OWN_PAGE).status).toBe(302);
  });

  test.each([
    ["sec-purpose", "prefetch;prerender"],
    ["next-router-prefetch", "1"],
    ["sec-fetch-dest", "image"],
    ["sec-fetch-dest", "iframe"],
    ["sec-fetch-dest", "empty"],
  ])("answers 204 without counting for %s: %s", (name, value) => {
    const res = get(DESTINATION, { ...OWN_PAGE, [name]: value });
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(capture).not.toHaveBeenCalled();
  });

  test.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1)",
    "Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)",
    "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/142.0 Safari/537.36",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0)",
    "curl/8.4.0",
    "",
  ])(
    "redirects the user agent %p without counting",
    (agent) => {
      const res = get(DESTINATION, { "user-agent": agent });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(DESTINATION);
      expect(capture).not.toHaveBeenCalled();
    },
  );

  test("does not count a HEAD request", () => {
    const redirect = get(DESTINATION, OWN_PAGE, "HEAD");
    const confirm = get(DESTINATION, {}, "HEAD");
    expect(redirect.status).toBe(302);
    expect(confirm.status).toBe(200);
    expect(capture).not.toHaveBeenCalled();
  });

  test("keeps redirecting past the limit and stops counting", () => {
    setSystemTime(NOW);
    const total = 200;
    const statuses = Array.from(
      { length: total },
      () => get(DESTINATION, OWN_PAGE).status,
    );
    expect(new Set(statuses)).toEqual(new Set([302]));
    expect(capture.mock.calls.length).toBeGreaterThan(0);
    expect(capture.mock.calls.length).toBeLessThan(total);
  });

  test("the limit applies per client", () => {
    setSystemTime(NOW);
    exhaustClickCount("first");
    get(DESTINATION, { ...OWN_PAGE, "x-vercel-forwarded-for": "second" });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  test("counting resumes after the window", () => {
    setSystemTime(NOW);
    exhaustClickCount("returning");
    setSystemTime(TWO_SECONDS_LATER);
    get(DESTINATION, { ...OWN_PAGE, "x-vercel-forwarded-for": "returning" });
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
