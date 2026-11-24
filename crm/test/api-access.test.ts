import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import {
  type Acted,
  type SiteFailure,
  createAccessClient,
} from "@/lib/api-access";
import { SECRET_CHARS } from "@/lib/api-access-contract/contract";
import { ROW } from "./team-view";

const TOKEN = "crm-admin-token-for-tests-0123456789";
const COUNTS = { pending: 0, approved: 1, declined: 0, revoked: 0 };
const LINK_TOKEN = "L".repeat(SECRET_CHARS);
const CUT_AFTER_MS = 50;

type Answer =
  | { status: number; body: unknown }
  | { status: number; raw: string; headers?: Record<string, string> };
let answer: Answer | ((url: URL) => Answer) = { status: 200, body: {} };
const seen: { auth: string | null; url: URL; body: string }[] = [];

const site = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({
      auth: req.headers.get("authorization"),
      url,
      body: await req.text(),
    });
    const given = typeof answer === "function" ? answer(url) : answer;
    if ("raw" in given) {
      const { status, raw, headers } = given;
      return new Response(raw, { status, ...(headers ? { headers } : {}) });
    }
    return Response.json(given.body, { status: given.status });
  },
});
const origin = `http://localhost:${site.port}`;
const client = createAccessClient({ origin, token: TOKEN });

beforeEach(() => {
  answer = { status: 200, body: {} };
  seen.length = 0;
});
let siteErrors: Mock<typeof console.error>;
beforeEach(() => {
  siteErrors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => siteErrors.mockRestore());

afterAll(() => site.stop(true));

describe("API access client", () => {
  test("lists one status tab with the admin token", async () => {
    const unreadable = [crypto.randomUUID()];
    answer = {
      status: 200,
      body: { requests: [ROW], counts: COUNTS, unreadable },
    };
    const listed = await client.listAccessRequests("approved");
    expect(listed).toEqual({
      ok: true,
      requests: [ROW],
      counts: COUNTS,
      unreadable,
    });
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.url.pathname).toBe("/api/internal/api-access");
    expect(seen[0]?.url.searchParams.get("status")).toBe("approved");
  });

  test("a new link points at the status page with the token", async () => {
    answer = { status: 200, body: { request: ROW, token: LINK_TOKEN } };
    const acted = await client.actOnRequest(ROW.id, {
      action: "reissue_link",
    });
    expect(acted.ok && acted.link).toBe(
      `${origin}/api-access/status#${LINK_TOKEN}`,
    );
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      action: "reissue_link",
    });
  });

  test("only a new status link carries a link", async () => {
    answer = { status: 200, body: { request: ROW } };
    expect(await client.actOnRequest(ROW.id, { action: "approve" }))
      .toEqual({ ok: true, request: ROW, link: null });
    expect(await client.actOnRequest(ROW.id, { action: "reissue_link" }))
      .toEqual({ ok: false, error: "bad_answer" });
  });

  test("a list it cannot read is reported, not shown empty", async () => {
    answer = { status: 200, body: { requests: [{ id: ROW.id }] } };
    expect(await client.listAccessRequests("pending")).toEqual({
      ok: false,
      error: "bad_answer",
    });
  });

  test("refusals and failures come back by name", async () => {
    type Failed = Extract<Acted, { ok: false }>["error"];
    const cases: [Answer, Failed][] = [
      [
        { status: 409, body: { error: "illegal_transition" } },
        "illegal_transition",
      ],
      [{ status: 404, body: { error: "not_found" } }, "not_found"],
      [{ status: 401, body: { error: "unauthorized" } }, "unauthorized"],
      [{ status: 503, body: { error: "unconfigured" } }, "unconfigured"],
      [{ status: 503, body: { error: "unavailable" } }, "unavailable"],
      [{ status: 500, body: { error: "unreadable" } }, "unreadable"],
      [{ status: 500, body: null }, "site_error"],
      [{ status: 502, body: { error: "bad gateway" } }, "site_error"],
      [{ status: 503, raw: "<html>Service Unavailable</html>" }, "site_error"],
      [{ status: 401, body: { message: "sign in" } }, "site_error"],
      [{ status: 403, raw: "Forbidden" }, "site_error"],
      [{ status: 400, body: { error: "invalid" } }, "invalid"],
      [
        { status: 308, raw: "", headers: { location: "https://other.test/" } },
        "redirected",
      ],
      [{ status: 200, body: { request: { id: ROW.id } } }, "bad_answer"],
    ];
    for (const [given, error] of cases) {
      answer = given;
      expect(await client.actOnRequest(ROW.id, { action: "approve" }))
        .toEqual({ ok: false, error });
    }
  });

  test("declining many sends one reasoned decline per request", async () => {
    answer = { status: 200, body: { request: ROW } };
    const ids = Array.from({ length: 19 }, () => crypto.randomUUID());
    const results = await client.declineEach(ids, "Declined as spam.");
    expect(results.every((r) => r.ok)).toBe(true);
    const posted = seen.map((s) => s.url.pathname.split("/").at(-1));
    expect(posted.toSorted()).toEqual(ids.toSorted());
    for (const s of seen) {
      expect(JSON.parse(s.body)).toEqual({
        action: "decline",
        reason: "Declined as spam.",
      });
    }
  });

  test("declining many goes on past requests decided elsewhere", async () => {
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    const settled: Record<number, Answer> = {
      1: { status: 409, body: { error: "illegal_transition" } },
      2: { status: 409, body: { error: "conflict" } },
      12: { status: 404, body: { error: "not_found" } },
    };
    answer = (url) => {
      const at = ids.indexOf(url.pathname.split("/").at(-1) ?? "");
      return settled[at] ?? { status: 200, body: { request: ROW } };
    };
    const results = await client.declineEach(ids, "Declined as spam.");
    expect(results).toHaveLength(ids.length);
    expect(results[1]).toEqual({ ok: false, error: "illegal_transition" });
    expect(results[2]).toEqual({ ok: false, error: "conflict" });
    expect(results[12]).toEqual({ ok: false, error: "not_found" });
    expect(results.filter((r) => r.ok)).toHaveLength(17);
  });

  test("declining many stops after the batch where the site fails",
    async () => {
      const stops: [Answer, SiteFailure][] = [
        [{ status: 401, body: { error: "unauthorized" } }, "unauthorized"],
        [{ status: 503, body: { error: "unconfigured" } }, "unconfigured"],
        [{ status: 500, body: null }, "site_error"],
        [{ status: 404, body: null }, "no_route"],
        [{ status: 503, body: { error: "unavailable" } }, "unavailable"],
        [{ status: 200, body: { unexpected: true } }, "bad_answer"],
        [
          { status: 302, raw: "", headers: { location: "/elsewhere" } },
          "redirected",
        ],
      ];
      for (const [given, error] of stops) {
        const ids = Array.from({ length: 30 }, () => crypto.randomUUID());
        const failing = ids[3];
        answer = (url) =>
          url.pathname.endsWith(`/${failing}`)
            ? given
            : { status: 200, body: { request: ROW } };
        seen.length = 0;
        const results = await client.declineEach(ids, "Declined as spam.");
        expect(results.length).toBeLessThan(ids.length);
        expect(seen).toHaveLength(results.length);
        expect(results[3]).toEqual({ ok: false, error });
        expect(results.filter((r) => !r.ok)).toHaveLength(1);
      }
    });

  test("an answer cut off midway is reported as unreachable", async () => {
    const cutting = Bun.listen({
      hostname: "localhost",
      port: 0,
      socket: {
        data(socket) {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{");
          setTimeout(() => socket.end(), CUT_AFTER_MS);
        },
      },
    });
    const cut = createAccessClient({
      origin: `http://localhost:${cutting.port}`,
      token: TOKEN,
    });
    try {
      expect(await cut.listAccessRequests("pending"))
        .toEqual({ ok: false, error: "unreachable" });
    } finally {
      cutting.stop(true);
    }
  });

  test("an unreachable site is reported as unreachable", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = closed.port;
    closed.stop(true);
    const away = createAccessClient({
      origin: `http://localhost:${port}`,
      token: TOKEN,
    });
    expect(await away.listAccessRequests("pending")).toEqual({
      ok: false,
      error: "unreachable",
    });
  });

  test("without a token nothing is sent", async () => {
    const bare = createAccessClient({ origin, token: "" });
    expect(await bare.listAccessRequests("pending")).toEqual({
      ok: false,
      error: "unconfigured",
    });
    expect(seen).toHaveLength(0);
  });
});
