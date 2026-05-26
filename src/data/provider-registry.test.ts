import { describe, expect, test } from "bun:test";
import { safeRegistryURL, getProviderRegistry } from "./provider-registry";

describe("safeRegistryURL", () => {
  test("accepts https", () => {
    expect(safeRegistryURL("https://relay.link")).toBe("https://relay.link");
  });
  test("accepts http (some self-hosted providers)", () => {
    expect(safeRegistryURL("http://localhost:8080")).toBe("http://localhost:8080");
  });
  test("rejects javascript: scheme (xss vector)", () => {
    expect(safeRegistryURL("javascript:alert(1)")).toBeUndefined();
    expect(safeRegistryURL("JaVaScRiPt:alert(1)")).toBeUndefined();
  });
  test("rejects data: scheme", () => {
    expect(safeRegistryURL("data:text/html,<script>alert(1)</script>")).toBeUndefined();
  });
  test("rejects file: and vbscript: schemes", () => {
    expect(safeRegistryURL("file:///etc/passwd")).toBeUndefined();
    expect(safeRegistryURL("vbscript:msgbox(1)")).toBeUndefined();
  });
  test("rejects garbage", () => {
    expect(safeRegistryURL("not a url")).toBeUndefined();
    expect(safeRegistryURL("")).toBeUndefined();
    expect(safeRegistryURL(undefined)).toBeUndefined();
  });
});

describe("getProviderRegistry sanitises URLs", () => {
  test("returns http(s) url unchanged for legitimate provider", () => {
    const entry = getProviderRegistry("relay");
    expect(entry?.url).toMatch(/^https:\/\//);
  });
  test("lowercases the slug lookup", () => {
    expect(getProviderRegistry("RELAY")).toEqual(getProviderRegistry("relay"));
  });
});
