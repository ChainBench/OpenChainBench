import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { headerNavItems, navGroups, navItems } from "@/components/site-nav-items";

const hrefs = (hidden: string[] = []) => navItems(hidden).map((i) => i.href);

describe("nav gate", () => {
  // The menu is drawn by two client components. Anything they need to
  // know about the environment has to arrive as a prop, because Next only
  // inlines NEXT_PUBLIC_-prefixed variables into a client bundle.
  test("the nav module reads no environment variable, directly or through a helper", () => {
    const file = readFileSync(path.join(process.cwd(), "src/components/site-nav-items.ts"), "utf8");
    const code = file.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // process.env in here is invisible in the browser: it reads undefined,
    // the guard passes, and the menu links a route production 404s.
    expect(code).not.toContain("process.env");
    // removed-benches is the module that reads VERCEL_ENV at import time,
    // so importing it puts the same dead flag in the client bundle.
    expect(code).not.toContain("removed-benches");
  });

  test("no argument means the full nav, which is the safe default for a menu", () => {
    expect(hrefs()).toContain("/speedtest-rpc");
    expect(hrefs()).toContain("/rpc-map");
  });

  test("a hidden route leaves the nav entirely", () => {
    const shown = hrefs(["/rpc-map"]);
    expect(shown).not.toContain("/rpc-map");
    expect(shown).toContain("/speedtest-rpc");
    // and it is gone from the groups the sidebar walks, not just the flat list
    expect(navGroups(["/rpc-map"]).flatMap((g) => g.items.map((i) => i.href))).not.toContain("/rpc-map");
  });

  test("hiding every gateable route leaves the rest of the nav intact", () => {
    const shown = hrefs(["/rpc-map", "/speedtest-rpc"]);
    expect(shown).not.toContain("/rpc-map");
    expect(shown).not.toContain("/speedtest-rpc");
    expect(shown).toContain("/rpc");
    expect(shown).toContain("/benchmarks");
    expect(shown).toContain("/data-api");
  });

  test("the header row follows the same gate", () => {
    expect(headerNavItems(["/rpc-map"]).map((i) => i.href)).not.toContain("/rpc-map");
  });

  test("an unknown route changes nothing", () => {
    expect(hrefs(["/not-a-route"]).length).toBe(hrefs().length);
  });
});
