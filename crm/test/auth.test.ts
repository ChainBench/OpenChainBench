import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CRM_PASSWORD = "correct horse battery staple";
process.env.CRM_SESSION_SECRET = "a-random-session-secret-for-tests";
process.env.SNAPSHOT_DIR = mkdtempSync(path.join(tmpdir(), "ocb-crm-auth-"));
const { authConfigured, isValidSession, issueSession, loginAllowed, parseSession, passwordMatches, recordLoginAttempt, revokeSession, sessionSigned } =
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
  test("login attempts are limited per client", () => {
    const key = "203.0.113.9";
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 10; i += 1) {
      expect(loginAllowed(key, t0 + i)).toBe(true);
      recordLoginAttempt(key, t0 + i);
    }
    expect(loginAllowed(key, t0 + 11)).toBe(false);
    expect(loginAllowed(key, t0 + 15 * 60_000 + 1)).toBe(true);
    expect(loginAllowed("198.51.100.1", t0 + 11)).toBe(true);
  });
});
