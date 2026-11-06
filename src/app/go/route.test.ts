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
import { readVisitors } from "@/lib/visitor";
import { settleAfter } from "@/test/after-queue";
import { fakeStore } from "@/test/fake-store";
import { posthogCookie } from "@/test/posthog-cookie";

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0 Safari/537.36";
const ORIGIN = "https://openchainbench.com";
const OLD_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1";
const OWN_PAGE = { referer: `${ORIGIN}/rpc`, "sec-fetch-site": "same-origin" };
const DESTINATION = "https://www.quicknode.com/pricing";
const NOW = new Date("2026-11-05T12:00:00Z");
const TWO_SECONDS_LATER = new Date("2026-11-05T12:00:02Z");
const FOUR_SECONDS_LATER = new Date("2026-11-05T12:00:04Z");
const READER = "0b7d1e6c-3f4a-4c1e-9a52-6f0e8d2b7c11";
const OTHER_READER = "5c2e9f80-1d3b-4a7e-8c64-2b9f0a1e3d57";
const POSTHOG_COOKIE = "ph_phc_test_posthog";

const capture = mock<typeof analytics.captureServer>(() => {});
mock.module("@/lib/analytics-server", () => ({
  ...analytics,
  captureServer: capture,
  readSiteVisitors: (req: Request) =>
    readVisitors(req.headers.get("cookie"), POSTHOG_COOKIE),
}));
const { GET } = await import("./route");

let clients = 0;

function visit(
  url: URL | string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Response> {
  return GET(
    new Request(url, {
      method,
      headers: {
        "user-agent": BROWSER,
        "x-vercel-forwarded-for": `client-${clients}`,
        ...headers,
      },
    }),
  );
}

function get(
  to: string | null,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Response> {
  const query = to === null ? "" : `?to=${encodeURIComponent(to)}`;
  return visit(`${ORIGIN}/go${query}`, headers, method);
}

function issuedCookie(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function capturedEvents(): Promise<unknown[]> {
  await settleAfter();
  return capture.mock.calls.map(([, event, props]) => ({ event, ...props }));
}

async function countedVisitors(): Promise<unknown[]> {
  await settleAfter();
  return capture.mock.calls.map(([, , , visitor]) => visitor);
}

function continueLink(html: string): URL {
  const href = html.match(/<a href="([^"]+)"/)?.[1];
  if (href === undefined) throw new Error("no Continue link");
  const unescaped = href
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  return new URL(unescaped, ORIGIN);
}

async function exhaustClickCount(client: string): Promise<void> {
  const headers = { ...OWN_PAGE, "x-vercel-forwarded-for": client };
  for (let i = 0; i < 1000; i += 1) {
    capture.mockClear();
    await get(`${DESTINATION}?n=${i}`, headers);
    await settleAfter();
    if (capture.mock.calls.length === 0) return;
  }
  throw new Error("the limit never stopped the count");
}

beforeEach(() => {
  clients += 1;
  fakeStore.reset();
  capture.mockClear();
});

afterEach(() => {
  setSystemTime();
});

describe("GET /go", () => {
  test("counts a click from one of our pages once", async () => {
    const res = await get(DESTINATION, {
      referer: `${ORIGIN}/products/quicknode`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-dest": "document",
      cookie: `ocb_vid=${READER}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DESTINATION);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await capturedEvents()).toEqual([
      expect.objectContaining({
        event: "outbound_click",
        via: "go",
        repeat_checked: true,
      }),
    ]);
    expect(await countedVisitors()).toEqual([
      { distinctId: READER, sessionId: null, source: "go" },
    ]);
  });

  test("sets the cookie the click is counted under", async () => {
    const res = await get(DESTINATION, OWN_PAGE);
    const cookie = res.headers.get("set-cookie") ?? "";
    const [issued] = readVisitors(issuedCookie(res), null);
    const id = issued?.distinctId;
    expect(id).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(await countedVisitors()).toEqual([
      { distinctId: id, sessionId: null, source: "go" },
    ]);
  });

  test("redirects a same-origin click without a referer", async () => {
    const res = await get(DESTINATION, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(302);
    expect(await capturedEvents()).toEqual([
      expect.objectContaining({ via: "go", page: "" }),
    ]);
  });

  test("confirms a foreign referer without counting", async () => {
    const res = await get(DESTINATION, {
      referer: "https://mail.example/inbox",
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain("quicknode.com</a>");
    expect(html).not.toContain("www.quicknode.com<");
    expect(await capturedEvents()).toEqual([]);
  });

  test("counts once the reader continues from the confirmation", async () => {
    const html = await (
      await get(DESTINATION, { "sec-fetch-site": "none" })
    ).text();
    const link = continueLink(html);
    expect(link.pathname).toBe("/go");
    expect(link.searchParams.get("to")).toBe(DESTINATION);

    const continued = await visit(link, {
      referer: `${ORIGIN}/go`,
      "sec-fetch-site": "same-origin",
    });
    expect(continued.status).toBe(302);
    expect(continued.headers.get("location")).toBe(DESTINATION);
    expect(await capturedEvents()).toEqual([
      expect.objectContaining({ via: "confirm", page: "" }),
    ]);
  });

  test("counts an older Safari coming from our page", async () => {
    const res = await get(DESTINATION, {
      referer: `${ORIGIN}/rpc`,
      "user-agent": OLD_SAFARI,
    });
    expect(res.status).toBe(302);
    expect(await capturedEvents()).toEqual([
      expect.objectContaining({ via: "go", page: "/rpc" }),
    ]);
  });

  test.each([
    ["an app that reloads links itself", { "sec-fetch-site": "none" }],
    ["a proxy that strips fetch metadata", { referer: `${ORIGIN}/rpc` }],
  ])("counts Continue once from %s", async (_name, headers) => {
    const first = await get(DESTINATION, headers);
    expect(await capturedEvents()).toEqual([]);
    const link = continueLink(await first.text());

    const continued = await visit(link, headers);
    const reused = await visit(link, headers);
    expect(continued.headers.get("location")).toBe(DESTINATION);
    expect(continueLink(await reused.text()).href).toBe(DESTINATION);
    expect(await capturedEvents()).toEqual([
      expect.objectContaining({ via: "confirm", href: DESTINATION }),
    ]);
  });

  test("pass bound to its destination", async () => {
    const page = await get(DESTINATION, { "sec-fetch-site": "none" });
    const link = continueLink(await page.text());
    link.searchParams.set("to", "https://drpc.org/");
    const res = await visit(link, { "sec-fetch-site": "none" });
    expect(res.status).toBe(200);
    expect(await capturedEvents()).toEqual([]);
  });

  test("does not count a Continue link after an hour", async () => {
    setSystemTime(NOW);
    const page = await get(DESTINATION, { "sec-fetch-site": "none" });
    const link = continueLink(await page.text());
    setSystemTime(new Date(NOW.getTime() + 61 * 60 * 1000));
    const res = await visit(link, { "sec-fetch-site": "none" });
    expect(res.status).toBe(200);
    expect(await capturedEvents()).toEqual([]);
  });

  test("pass redemption is rate limited", async () => {
    setSystemTime(NOW);
    const reload = { "sec-fetch-site": "none" };
    const page = await get(DESTINATION, reload);
    const link = continueLink(await page.text());
    for (let i = 0; i < 60; i += 1) await get(`${DESTINATION}?n=${i}`, reload);
    const res = await visit(link, reload);
    expect(res.status).toBe(200);
    expect(await capturedEvents()).toEqual([]);
  });

  test.each([
    ["a HEAD request", {}, "HEAD"],
    ["a prefetch", { "sec-purpose": "prefetch" }, "GET"],
    ["a link preview bot", { "user-agent": "curl/8.4.0" }, "GET"],
  ])("keeps the Continue link usable after %s", async (_, headers, method) => {
    const reload = { "sec-fetch-site": "none" };
    const page = await get(DESTINATION, reload);
    const link = continueLink(await page.text());
    await visit(link, { ...reload, ...headers }, method);
    const continued = await visit(link, reload);
    expect(continued.status).toBe(302);
    expect(await capturedEvents()).toEqual([
      expect.objectContaining({ via: "confirm" }),
    ]);
  });

  test.each([
    ["down", () => (fakeStore.down = true)],
    ["not configured", () => (fakeStore.configured = false)],
  ])("never loops on confirmation while the store is %s", async (_n, stop) => {
    stop();
    const agent = { "user-agent": OLD_SAFARI };
    const html = await (await get(DESTINATION, agent)).text();
    const link = continueLink(html);
    expect(link.searchParams.has("pass")).toBe(false);
    const again = await visit(link, agent);
    expect(continueLink(await again.text()).href).toBe(DESTINATION);
    expect(await capturedEvents()).toEqual([]);
  });

  test.each([
    ["path", `https://example.com/"><script>alert(1)</script>`],
    ["fragment", `https://example.com/#'onmouseover=alert(1)`],
    ["host", `https://a"onmouseover='alert(1)'.example/`],
  ])("escapes the destination %s when confirming", async (_name, to) => {
    const res = await get(to);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/"onmouseover|'onmouseover|'alert/);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test("keeps the destination intact in the Continue link", async () => {
    const to = "https://example.com/it's?a=1&amp;b=2";
    const page = await get(to, { "sec-fetch-site": "none" });
    const link = continueLink(await page.text());
    expect(link.searchParams.get("to")).toBe(to);
  });

  test("names the whole host when it only starts like www", async () => {
    const html = await (await get("https://awww.example.com/")).text();
    expect(html).toContain("Continue to awww.example.com</a>");
  });

  test("answers 400 without counting for an invalid destination", async () => {
    const res = await get("javascript:alert(1)", OWN_PAGE);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain('<a href="/benchmarks"');
    expect(await capturedEvents()).toEqual([]);
  });

  test("redirects from a page on another deployment host", async () => {
    const host = "https://staging.example";
    const to = encodeURIComponent(DESTINATION);
    const res = await GET(
      new Request(`${host}/go?to=${to}`, {
        headers: {
          "user-agent": BROWSER,
          referer: `${host}/rpc`,
          "sec-fetch-site": "same-origin",
        },
      }),
    );
    expect(res.status).toBe(302);
  });

  test.each([
    ["sec-purpose", "prefetch;prerender"],
    ["purpose", "prefetch"],
    ["x-purpose", "preview"],
    ["next-router-prefetch", "1"],
    ["sec-fetch-dest", "image"],
    ["sec-fetch-dest", "iframe"],
    ["sec-fetch-dest", "empty"],
  ])("answers 204 without counting for %s: %s", async (name, value) => {
    const res = await get(DESTINATION, { ...OWN_PAGE, [name]: value });
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await capturedEvents()).toEqual([]);
  });

  test("redirects a search engine without counting", async () => {
    const agent =
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    const res = await get(DESTINATION, { "user-agent": agent });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DESTINATION);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await capturedEvents()).toEqual([]);
  });

  test.each(["curl/8.4.0", ""])(
    "shows the user agent %p a link without counting",
    async (agent) => {
      const res = await get(DESTINATION, { ...OWN_PAGE, "user-agent": agent });
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(continueLink(await res.text()).href).toBe(DESTINATION);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await capturedEvents()).toEqual([]);
    },
  );

  test("does not count a HEAD request", async () => {
    const redirect = await get(DESTINATION, OWN_PAGE, "HEAD");
    const confirm = await get(DESTINATION, {}, "HEAD");
    expect(redirect.status).toBe(302);
    expect(confirm.status).toBe(200);
    expect(await capturedEvents()).toEqual([]);
  });

  test("keeps redirecting past the limit and stops counting", async () => {
    setSystemTime(NOW);
    const total = 200;
    const statuses = new Set<number>();
    for (let i = 0; i < total; i += 1) {
      statuses.add((await get(`${DESTINATION}?n=${i}`, OWN_PAGE)).status);
    }
    expect(statuses).toEqual(new Set([302]));
    await settleAfter();
    expect(capture.mock.calls.length).toBeGreaterThan(0);
    expect(capture.mock.calls.length).toBeLessThan(total);
  });

  test("counts a repeated opening of the same link once", async () => {
    await get(DESTINATION, OWN_PAGE);
    await get(DESTINATION, OWN_PAGE);
    await get("https://drpc.org/", OWN_PAGE);
    expect(await capturedEvents()).toEqual([
      expect.objectContaining({ href: DESTINATION }),
      expect.objectContaining({ href: "https://drpc.org/" }),
    ]);
  });

  test("repeat window expires", async () => {
    setSystemTime(NOW);
    await get(DESTINATION, OWN_PAGE);
    setSystemTime(TWO_SECONDS_LATER);
    await get(DESTINATION, OWN_PAGE);
    setSystemTime(FOUR_SECONDS_LATER);
    await get(DESTINATION, OWN_PAGE);
    expect(await capturedEvents()).toHaveLength(2);
  });

  test("repeat after the analytics cookie appears", async () => {
    const cookie = issuedCookie(await get(DESTINATION, OWN_PAGE));
    const posthog = posthogCookie(POSTHOG_COOKIE, {
      distinct_id: "0193-visitor",
    });
    await get(DESTINATION, { ...OWN_PAGE, cookie: `${cookie}; ${posthog}` });
    expect(await capturedEvents()).toHaveLength(1);
  });

  test("repeat after the issued cookie", async () => {
    const cookie = issuedCookie(await get(DESTINATION, OWN_PAGE));
    await get(DESTINATION, { ...OWN_PAGE, cookie });
    expect(await capturedEvents()).toHaveLength(1);
  });

  test("counts a Continue clicked twice once", async () => {
    const page = await get(DESTINATION, { "sec-fetch-site": "none" });
    const headers = {
      "sec-fetch-site": "same-origin",
      cookie: issuedCookie(page),
    };
    const link = continueLink(await page.text());
    await visit(link, headers);
    await visit(link, headers);
    expect(await capturedEvents()).toEqual([
      expect.objectContaining({ via: "confirm" }),
    ]);
  });

  test("tells apart readers without cookie by address and agent", async () => {
    await get(DESTINATION, { ...OWN_PAGE, "x-vercel-forwarded-for": "office" });
    await get(DESTINATION, { ...OWN_PAGE, "x-vercel-forwarded-for": "home" });
    await get(DESTINATION, {
      ...OWN_PAGE,
      "x-vercel-forwarded-for": "office",
      "user-agent": `${BROWSER} Edg/142.0`,
    });
    expect(await capturedEvents()).toHaveLength(3);
  });

  test.each([
    ["down", () => (fakeStore.down = true)],
    ["not configured", () => (fakeStore.configured = false)],
  ])("counts unchecked while the store is %s", async (_name, breakStore) => {
    breakStore();
    await get(DESTINATION, OWN_PAGE);
    await get(DESTINATION, OWN_PAGE);
    expect(await capturedEvents()).toEqual([
      expect.objectContaining({ repeat_checked: false }),
      expect.objectContaining({ repeat_checked: false }),
    ]);
  });

  test("counts two readers behind one address separately", async () => {
    await get(DESTINATION, { ...OWN_PAGE, cookie: `ocb_vid=${READER}` });
    await get(DESTINATION, { ...OWN_PAGE, cookie: `ocb_vid=${OTHER_READER}` });
    await get(DESTINATION, { ...OWN_PAGE, cookie: `ocb_vid=${READER}` });
    expect(await countedVisitors()).toEqual([
      expect.objectContaining({ distinctId: READER }),
      expect.objectContaining({ distinctId: OTHER_READER }),
    ]);
  });

  test("counts the same reader once across addresses", async () => {
    const reader = { ...OWN_PAGE, cookie: `ocb_vid=${READER}` };
    await get(DESTINATION, { ...reader, "x-vercel-forwarded-for": "wifi" });
    await get(DESTINATION, { ...reader, "x-vercel-forwarded-for": "mobile" });
    expect(await capturedEvents()).toHaveLength(1);
  });

  test("the limit applies per client", async () => {
    setSystemTime(NOW);
    await exhaustClickCount("first");
    await get(DESTINATION, { ...OWN_PAGE, "x-vercel-forwarded-for": "second" });
    expect(await capturedEvents()).toHaveLength(1);
  });

  test("counting resumes once the client's allowance refills", async () => {
    setSystemTime(NOW);
    await exhaustClickCount("returning");
    setSystemTime(TWO_SECONDS_LATER);
    await get(DESTINATION, {
      ...OWN_PAGE,
      "x-vercel-forwarded-for": "returning",
    });
    expect(await capturedEvents()).toHaveLength(1);
  });
});
