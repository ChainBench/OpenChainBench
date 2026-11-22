import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET as capital } from "@/app/api/capital/route";
import { GET as citableDate } from "@/app/api/citable/[date]/route";
import { GET as citable } from "@/app/api/citable/route";
import { GET as cite } from "@/app/api/cite/[slug]/[format]/route";
import { GET as compare } from "@/app/api/compare/[a]/[b]/route";
import { GET as freshness } from "@/app/api/freshness/route";
import { GET as llmContext } from "@/app/api/llm-context/route";
import { GET as og } from "@/app/api/og/[slug]/route";
import { GET as sparkline } from "@/app/api/sparkline/[slug]/route";
import { GET as stat } from "@/app/api/stat/[slug]/route";
import { limitApiCall } from "./caller";
import { PUBLIC_PER_MINUTE, type PublicRoute } from "./public-limits";

type Call = (headers: Record<string, string>) => Promise<Response>;

const BAD_KEY = { authorization: "Bearer ocb_not-a-real-key" };

const request = (path: string, headers: Record<string, string>) =>
  new NextRequest(`http://localhost${path}`, { headers });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

const ROUTES: [PublicRoute, Call][] = [
  ["capital", (h) => capital(request("/api/capital", h))],
  ["citable", (h) => citable(request("/api/citable", h))],
  ["citable-date", (h) =>
    citableDate(request("/api/citable/2026-11-01", h),
      params({ date: "2026-11-01" }))],
  ["cite", (h) =>
    cite(request("/api/cite/ethereum-rpc/bibtex", h),
      params({ slug: "ethereum-rpc", format: "bibtex" }))],
  ["compare", (h) =>
    compare(request("/api/compare/ethereum-rpc/solana-rpc", h),
      params({ a: "ethereum-rpc", b: "solana-rpc" }))],
  ["freshness", (h) => freshness(request("/api/freshness", h))],
  ["llm-context", (h) => llmContext(request("/api/llm-context", h))],
  ["og", (h) =>
    og(request("/api/og/ethereum-rpc", h), params({ slug: "ethereum-rpc" }))],
  ["sparkline", (h) =>
    sparkline(request("/api/sparkline/ethereum-rpc", h),
      params({ slug: "ethereum-rpc" }))],
  ["stat", (h) =>
    stat(request("/api/stat/ethereum-rpc", h),
      params({ slug: "ethereum-rpc" }))],
];

let ip = 0;

function newCaller() {
  ip += 1;
  const from = { "x-vercel-forwarded-for": `203.0.113.${ip}` };
  const limit = (route: PublicRoute) =>
    limitApiCall(new Request("http://localhost", { headers: from }), route);
  const spend = async (route: PublicRoute) => {
    for (let i = 0; i < PUBLIC_PER_MINUTE[route]; i += 1) await limit(route);
  };
  return { from, limit, spend };
}

describe("public API routes", () => {
  test.each(ROUTES)("%s refuses a key that does not work", async (_, call) => {
    const res = await call(BAD_KEY);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  test.each(ROUTES)("%s keeps its public limit per IP", async (route, call) => {
    const caller = newCaller();
    await caller.spend(route);
    const res = await call(caller.from);
    expect(res.status).toBe(429);
  });

  test("each route has its own budget per IP", async () => {
    const caller = newCaller();
    await caller.spend("stat");
    expect((await caller.limit("stat"))?.status).toBe(429);
    expect(await caller.limit("compare")).toBeNull();
  });
});
