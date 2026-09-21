import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CRM_PASSWORD = "correct horse battery staple";
process.env.CRM_SESSION_SECRET = "a-random-session-secret-for-tests";
process.env.SNAPSHOT_DIR = mkdtempSync(path.join(tmpdir(), "ocb-crm-auth-"));
const { authConfigured, clientKey, isValidSession, issueSession, loginAllowed, parseSession, passwordMatches, recordLoginAttempt, resetLoginAttempts, revokeSession, sessionSigned } =
  await import("../lib/auth");

describe("auth", () => {
  test("configured with both secrets long enough", () => {
    expect(authConfigured()).toBe(true);
  });
  test("password check", async () => {
    expect(await passwordMatches("correct horse battery staple")).toBe(true);
    expect(await passwordMatches("correct horse battery stapl")).toBe(false);
    expect(await passwordMatches("")).toBe(false);
  });
  test("a session is random, signed, listed, and revocable", async () => {
    const a = await issueSession();
    const b = await issueSession();
    expect(a).not.toBe(b);
    expect(await isValidSession(a)).toBe(true);
    expect(await isValidSession(b)).toBe(true);
    await revokeSession(a);
    expect(await isValidSession(a)).toBe(false);
    expect(await isValidSession(b)).toBe(true);
  });
  test("tampering and expiry", async () => {
    const tok = await issueSession();
    const s = parseSession(tok)!;
    expect(await sessionSigned(s)).toBe(true);
    expect(await sessionSigned({ ...s, sig: `${s.sig.slice(0, 63)}${s.sig[63] === "0" ? "1" : "0"}` })).toBe(false);
    expect(await sessionSigned({ ...s, expiresAt: s.expiresAt + 1 })).toBe(false);
    expect(await sessionSigned(s, s.expiresAt + 1)).toBe(false);
    expect(parseSession("garbage")).toBeNull();
    expect(parseSession(undefined)).toBeNull();
    expect(await isValidSession(`${s.nonce}.${s.expiresAt}.${"0".repeat(64)}`)).toBe(false);
  });
  test("login attempts are limited per client and globally", () => {
    resetLoginAttempts();
    const key = "203.0.113.9";
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 10; i += 1) {
      expect(loginAllowed(key, t0 + i)).toBe(true);
      recordLoginAttempt(key, t0 + i);
    }
    expect(loginAllowed(key, t0 + 11)).toBe(false);
    expect(loginAllowed("198.51.100.1", t0 + 11)).toBe(true);
    // Rotating keys hit the global cap.
    for (let i = 0; i < 50; i += 1) recordLoginAttempt(`10.0.0.${i}`, t0 + 20 + i);
    expect(loginAllowed("198.51.100.2", t0 + 100)).toBe(false);
    expect(loginAllowed(key, t0 + 15 * 60_000 + 1)).toBe(true);
    resetLoginAttempts();
  });
  test("the client key is the last forwarded hop, never a header the client wrote alone", () => {
    const req = (h: Record<string, string>) => new Request("http://x/api/login", { headers: h });
    expect(clientKey(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientKey(req({ "x-real-ip": "9.9.9.9" }))).toBe("unknown");
  });
  test("concurrent logins all end up listed", async () => {
    const toks = await Promise.all([issueSession(), issueSession(), issueSession()]);
    for (const t of toks) expect(await isValidSession(t)).toBe(true);
  });
});
