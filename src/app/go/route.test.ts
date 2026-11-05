import {
  afterAll,
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

beforeEach(() => {
  clients += 1;
  capture.mockClear();
});

afterAll(() => {
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
      {
        event: "outbound_click",
        href: DESTINATION,
        host: "www.quicknode.com",
        page: "/products/quicknode",
        via: "go",
      },
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
      {
        event: "outbound_click",
        href: DESTINATION,
        host: "www.quicknode.com",
        page: "",
        via: "confirm",
      },
    ]);
  });

  test.each([
    ["path and query", `https://example.com/"><script>alert(1)</script>?a=1&b='2'`],
    ["fragment", `https://example.com/#"<img src=x onerror=alert(1)>`],
    ["host", `https://a"onmouseover='alert(1)'.example/`],
  ])("escapes the destination %s on the confirmation page", async (_name, to) => {
    const html = await get(to).text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/"onmouseover|'alert/);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test("answers 400 without counting for an invalid destination", () => {
    const res = get("javascript:alert(1)", OWN_PAGE);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  test.each([
    ["sec-purpose", "prefetch"],
    ["sec-purpose", "prefetch;prerender"],
    ["next-router-prefetch", "1"],
    ["sec-fetch-dest", "image"],
    ["sec-fetch-dest", "iframe"],
  ])("answers 204 without counting for %s: %s", (name, value) => {
    const res = get(DESTINATION, { ...OWN_PAGE, [name]: value });
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(capture).not.toHaveBeenCalled();
  });

  test.each(["Mozilla/5.0 (compatible; Googlebot/2.1)", "curl/8.4.0", ""])(
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
    setSystemTime(new Date("2026-11-05T12:00:00Z"));
    const total = 1000;
    const statuses = Array.from(
      { length: total },
      () => get(DESTINATION, OWN_PAGE).status,
    );
    expect(new Set(statuses)).toEqual(new Set([302]));
    expect(capture.mock.calls.length).toBeGreaterThan(0);
    expect(capture.mock.calls.length).toBeLessThan(total);
  });
});
