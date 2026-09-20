import { describe, expect, test } from "bun:test";

process.env.CRM_PASSWORD = "correct horse battery";
const { authConfigured, isValidSession, passwordMatches, sessionToken } = await import("../lib/auth");

describe("auth", () => {
  test("configured with a long enough password", () => {
    expect(authConfigured()).toBe(true);
  });
  test("token is stable and validates", async () => {
    const t = await sessionToken();
    expect(t).toHaveLength(64);
    expect(await sessionToken()).toBe(t);
    expect(await isValidSession(t)).toBe(true);
    expect(await isValidSession(`${t.slice(0, 63)}0`)).toBe(false);
    expect(await isValidSession(undefined)).toBe(false);
  });
  test("password check", async () => {
    expect(await passwordMatches("correct horse battery")).toBe(true);
    expect(await passwordMatches("correct horse batter")).toBe(false);
    expect(await passwordMatches("")).toBe(false);
  });
});
