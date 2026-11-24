import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { POST } from "@/app/api/internal/api-access/[id]/route";
import { GET } from "@/app/api/internal/api-access/route";
import {
  TEST_NOW as NOW,
  idForKey,
  issuedKey,
  jsonPost,
  submittedRequest,
  tokenOf,
  useTestAccess,
} from "@/test/api-access-fixtures";
import { isolateEnv, realRedisUrl } from "@/test/env";
import { quietConsole } from "@/test/quiet-console";
import { actForTeam, listForTeam } from "./team-api";
import { teamListSchema } from "./team-contract";

quietConsole();

const ADMIN = "a".repeat(32);
const URL_BASE = "http://localhost/api/internal/api-access";

const post = (body: unknown, auth?: string) =>
  jsonPost(body, auth ? { authorization: auth } : {});

async function errorOf(res: Response): Promise<string | undefined> {
  return z.object({ error: z.string().optional() }).parse(await res.json())
    .error;
}

describe("team routes", () => {
  isolateEnv(["API_ACCESS_ADMIN_TOKEN", "API_ACCESS_ADMIN_TOKEN_NEXT"]);
  const params = Promise.resolve({ id: crypto.randomUUID() });

  test("refuse callers without the admin token", async () => {
    process.env.API_ACCESS_ADMIN_TOKEN = ADMIN;
    expect((await GET(new Request(URL_BASE))).status).toBe(401);
    const approve = { action: "approve" };
    expect((await POST(post(approve), { params })).status).toBe(401);
    const wrong = post(approve, "Bearer wrong");
    expect((await POST(wrong, { params })).status).toBe(401);
  });

  test("stay closed when a token is missing or short", async () => {
    const missing = await GET(new Request(URL_BASE));
    expect(missing.status).toBe(503);
    expect(await errorOf(missing)).toBe("unconfigured");

    process.env.API_ACCESS_ADMIN_TOKEN = "short";
    const short = await POST(post({ action: "approve" }, "Bearer short"),
      { params });
    expect(await errorOf(short)).toBe("unconfigured");

    process.env.API_ACCESS_ADMIN_TOKEN = ADMIN;
    process.env.API_ACCESS_ADMIN_TOKEN_NEXT = "short";
    const next = await GET(new Request(URL_BASE, {
      headers: { authorization: `Bearer ${ADMIN}` },
    }));
    expect(await errorOf(next)).toBe("unconfigured");
  });

  test("the admin token gets past the gate", async () => {
    process.env.API_ACCESS_ADMIN_TOKEN = ADMIN;
    const res = await POST(post({ action: "delete" }, `Bearer ${ADMIN}`),
      { params });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid");
    const listed = await GET(new Request(`${URL_BASE}?status=nope`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    }));
    expect(listed.status).toBe(400);
    expect(await errorOf(listed)).toBe("invalid");
  });
});

describe.skipIf(!realRedisUrl)("team API on a real Redis", () => {
  const opened = useTestAccess();
  const { access } = opened;

  const act = (id: string, body: unknown) =>
    actForTeam(post(body), id, { access, now: NOW + 1 });
  const listed = (status: string) =>
    listForTeam(new Request(`${URL_BASE}?status=${status}`),
      { access, now: NOW + 1 });

  const pendingId = async () => (await submittedRequest(access)).request.id;

  test("the list follows the contract and holds no secret", async () => {
    const { id, key } = await issuedKey(access);
    const body = await (await listed("approved")).text();
    const list = teamListSchema.parse(JSON.parse(body));
    const row = list.requests.find((r) => r.id === id);
    expect(row?.key?.last4).toBe(key.slice(-4));
    expect(row?.decidedAt).toBe(NOW + 1);
    expect(list.counts.approved).toBeGreaterThanOrEqual(1);
    expect(body).not.toContain(key);
    expect(body).not.toMatch(/"hash"|tokenHash/);
  });

  test("a revoked row shows its revocation date and no secret", async () => {
    const { id, key } = await issuedKey(access);
    await access.decideOn(id, { to: "revoked" }, NOW + 5);
    const body = await (await listed("revoked")).text();
    const row = teamListSchema.parse(JSON.parse(body))
      .requests.find((r) => r.id === id);
    expect(row?.decidedAt).toBe(NOW + 5);
    expect(row?.key?.last4).toBe(key.slice(-4));
    expect(body).not.toMatch(/"hash"|tokenHash/);
  });

  test("declining needs a reason, then shows it", async () => {
    const id = await pendingId();
    for (const blank of [undefined, "", "  \n "]) {
      const refused = await act(id, { action: "decline", reason: blank });
      expect(refused.status).toBe(400);
    }
    const reason = "The site does not load.";
    const res = await act(id, { action: "decline", reason });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      request: { status: "declined", reason, decidedAt: NOW + 1 },
    });
  });

  test("a second decision is refused with 409", async () => {
    const id = await pendingId();
    await act(id, { action: "approve" });
    const again = await act(id, { action: "approve" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "illegal_transition" });
  });

  test("revoking names the key that stops working", async () => {
    const { id, key } = await issuedKey(access);
    const res = await act(id, { action: "revoke" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      request: { status: "revoked", key: { last4: key.slice(-4) } },
    });
    expect(await idForKey(access, key)).toBeNull();
  });

  test("a new link replaces the requester's old one", async () => {
    const { token, request } = await submittedRequest(access);
    expect(await opened.tokenStored(token)).toBe(true);
    const fresh = await tokenOf(await act(request.id,
      { action: "reissue_link" }));
    expect(await access.byToken(token)).toBeNull();
    expect(await opened.tokenStored(token)).toBe(false);
    expect((await access.byToken(fresh))?.id).toBe(request.id);
  });

  test("a new link keeps the requester's key working", async () => {
    const { id, key } = await issuedKey(access);
    const fresh = await tokenOf(await act(id, { action: "reissue_link" }));
    expect(await idForKey(access, key)).toBe(id);
    const view = await access.byToken(fresh);
    expect(view?.status).toBe("approved");
    expect(view?.status === "approved" && view.key?.last4)
      .toBe(key.slice(-4));
  });

  test("an unreadable record is named, never hidden", async () => {
    const id = await pendingId();
    const retyped = await pendingId();
    const readable = await pendingId();
    await opened.corruptRecord(id);
    await opened.retypeRecord(retyped);
    const list = teamListSchema.parse(await (await listed("pending")).json());
    expect(list.unreadable).toEqual(expect.arrayContaining([id, retyped]));
    const ids = list.requests.map((r) => r.id);
    expect(ids).toContain(readable);
    expect(ids).not.toContain(id);
    for (const broken of [id, retyped]) {
      const res = await act(broken, { action: "approve" });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "unreadable" });
    }
  });

  test("unknown ids and statuses are refused", async () => {
    for (const action of ["revoke", "reissue_link"]) {
      const res = await act(crypto.randomUUID(), { action });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    const res = await listed("archived");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid");
  });
});
