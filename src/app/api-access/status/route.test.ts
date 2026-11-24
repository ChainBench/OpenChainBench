import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../../../../next.config";
import { STATUS_PAGE_PATH } from "@/lib/api-access/contract";
import { GET } from "./route";

const hashOf = (source: string) =>
  `'sha256-${createHash("sha256").update(source).digest("base64")}'`;

function inline(html: string, tag: string): string[] {
  const found = [...html.matchAll(
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))]
    .map(([, body = ""]) => body);
  if (found.length === 0) throw new Error(`no inline ${tag}`);
  return found;
}

async function servedHeaders(path: string): Promise<Map<string, string>> {
  const served = new Map<string, string>();
  for (const rule of (await nextConfig.headers?.()) ?? []) {
    if (getPathMatch(rule.source)(path) === false) continue;
    for (const { key, value } of rule.headers) {
      served.set(key.toLowerCase(), value);
    }
  }
  return served;
}

async function servedPolicy(): Promise<Map<string, string[]>> {
  const csp = (await servedHeaders(STATUS_PAGE_PATH))
    .get("content-security-policy");
  if (!csp) throw new Error("no policy for the status page");
  return new Map(csp.split(";").map((directive) => {
    const [name = "", ...values] = directive.trim().split(/\s+/);
    return [name, values];
  }));
}

describe("status page", () => {
  test("its policy allows its own inline script, style and calls",
    async () => {
      const html = await GET().text();
      const policy = await servedPolicy();
      const scripts = inline(html, "script").map(hashOf);
      const styles = inline(html, "style").map(hashOf);
      expect(policy.get("script-src")).toEqual(scripts);
      expect(policy.get("style-src")).toEqual(styles);
      expect(policy.get("connect-src")).toEqual(["'self'"]);
      expect(policy.get("default-src")).toEqual(["'none'"]);
      expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    });

  test("its link is never sent as a referrer", async () => {
    const served = await servedHeaders(STATUS_PAGE_PATH);
    expect(served.get("referrer-policy")).toBe("no-referrer");
  });
});
