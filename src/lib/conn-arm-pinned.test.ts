import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A keyed row's success and sample count must describe its own arm.
 *
 * `rpc_call_total` carries `conn="warm"` or `conn="cold"` since 4 November.
 * Before that both arms shared one counter, so a cold-start row published
 * the warm row's success rate and a sample count that was the sum of both:
 * measured on ethereum us-east, 358 warm readings and 361 cold, with both
 * rows showing 719.
 *
 * The failure is silent in both directions. Forget the pin and the row
 * doubles its own sample count without erroring; pin the wrong arm and the
 * cold tab quietly republishes the warm figures. Neither shows up in a
 * build, a typecheck or a page render, so it is asserted here.
 *
 * Public rows are deliberately exempt: they come from the rpc-capabilities
 * harness, which emits no `conn` label, and pinning one would empty it.
 */
const DIR = join(import.meta.dir, "../../benchmarks");
const CALL_COUNTER = /ocb:rpc_call:(?:ok_rate_24h|rate_24h|increase_24h)\{([^}]*)\}/g;

type Row = { slug: string; tier: string | null; body: string };

function rows(src: string): Row[] {
  const parts = src.split(/\n  - slug: /).slice(1);
  return parts.map((p) => {
    const slug = p.split("\n")[0].trim();
    const m = p.match(/^    tier: (\S+)$/m);
    return { slug, tier: m ? m[1] : null, body: p };
  });
}

describe("a keyed row counts its own connection arm", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith("-rpc.yml"));

  test("every keyed and keyed-cold row pins the matching conn", () => {
    const wrong: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(DIR, f), "utf8");
      for (const r of rows(src)) {
        if (r.tier !== "keyed" && r.tier !== "keyed-cold") continue;
        const want = r.tier === "keyed" ? "warm" : "cold";
        for (const m of r.body.matchAll(CALL_COUNTER)) {
          if (!m[1].includes(`conn="${want}"`)) {
            wrong.push(`${f} ${r.slug} (tier ${r.tier}) wants conn="${want}": ${m[0].slice(0, 90)}`);
          }
        }
      }
    }
    expect(
      wrong,
      [
        "These rows read the call counter without pinning their own arm, so",
        "their success rate and sample count describe warm and cold together.",
        "A cold-start row then republishes the warm figures and doubles its n.",
      ].join("\n"),
    ).toEqual([]);
  });

  test("public rows never pin conn, which would empty them", () => {
    const wrong: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(DIR, f), "utf8");
      for (const r of rows(src)) {
        if (r.tier != null) continue;
        for (const m of r.body.matchAll(CALL_COUNTER)) {
          if (m[1].includes("conn=")) wrong.push(`${f} ${r.slug}: ${m[0].slice(0, 90)}`);
        }
      }
    }
    expect(
      wrong,
      "A public row pins conn. The no-key harness emits no such label, so the cell would go blank.",
    ).toEqual([]);
  });
});
