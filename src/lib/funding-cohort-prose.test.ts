import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

/**
 * Bench 043 states its cohort twice in prose, in seo_intro and again in a
 * methodology bullet, split by which of the two funding metrics each venue is
 * read from. Both enumerations were wrong at once and had been for a while.
 *
 * The bullet claimed 8 venues on each source, 16 against the 20 the spec
 * declared. It named Deribit, which the bench has never carried, filed Ondo
 * Perps under the directly polled set when it arrives through Mobula, and
 * omitted Polymarket, Kalshi, Vest, StandX and ApeX Omni. seo_intro repeated
 * all four errors, and fixing only the bullet on 2026-10-21 left them in
 * place, which is why this is a test and not a more careful re-read.
 *
 * A reader checks a cohort claim against the table. Nothing else did.
 */
const BENCH = join(import.meta.dir, "..", "..", "benchmarks");

type Spec = {
  seo_intro?: string;
  abstract?: string;
  methodology?: string[];
  providers?: { slug: string; name: string; queries?: { p50?: string } }[];
};

const spec = yaml.load(
  readFileSync(join(BENCH, "perp-funding-stability.yml"), "utf8"),
) as Spec;

/** The metric a provider's headline reads is what puts it in one group. */
function split() {
  const direct: string[] = [];
  const mobula: string[] = [];
  for (const p of spec.providers ?? []) {
    const q = p.queries?.p50 ?? "";
    (q.includes("perp_funding_hold_24h_bps") ? direct : mobula).push(p.name);
  }
  return { direct, mobula };
}

/** Every venue name the cohort sentence enumerates, in order. */
function enumerated(text: string) {
  const names = (spec.providers ?? []).map((p) => p.name);
  return names.filter((n) => text.includes(n));
}

describe("bench 043 states the cohort it actually has", () => {
  const { direct, mobula } = split();

  const cohortBullet = (spec.methodology ?? []).find((b) =>
    b.startsWith("Cohort."),
  );

  test("the methodology bullet names every venue and only those venues", () => {
    expect(cohortBullet).toBeDefined();
    const named = enumerated(cohortBullet as string);
    // Order matters here only as a readable failure: the sets are what count.
    expect(new Set(named)).toEqual(new Set([...direct, ...mobula]));
  });

  test("the seo intro names every venue and only those venues", () => {
    // The enumeration lives in seo_intro; the abstract below it describes
    // the series and names no venues.
    const named = enumerated(spec.seo_intro ?? "");
    expect(new Set(named)).toEqual(new Set([...direct, ...mobula]));
  });

  test("the counts the bullet states match the two groups", () => {
    // Spelled or digits, both appear in these specs over time.
    const words: Record<string, number> = {
      eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
      nineteen: 19, twenty: 20, "twenty-one": 21,
    };
    const asNumber = (token: string) =>
      words[token.toLowerCase()] ?? Number(token);

    const bullet = cohortBullet as string;
    const totalClaim = bullet.match(/^Cohort\.\s+([A-Za-z-]+|\d+) venues/);
    expect(totalClaim, "the bullet must open with its venue count").not.toBeNull();
    expect(asNumber(totalClaim![1])).toBe(direct.length + mobula.length);

    const directClaim = bullet.match(
      /([A-Za-z-]+|\d+) polled directly/,
    );
    expect(directClaim).not.toBeNull();
    expect(asNumber(directClaim![1])).toBe(direct.length);

    const mobulaClaim = bullet.match(/([A-Za-z-]+|\d+) via the Mobula/);
    expect(mobulaClaim).not.toBeNull();
    expect(asNumber(mobulaClaim![1])).toBe(mobula.length);
  });

  test("neither enumeration names a venue the bench does not declare", () => {
    // The specific trap: Deribit is on perp-funding-cost-30d, on the same
    // upstream, and was named here as a member for months.
    const declared = new Set((spec.providers ?? []).map((p) => p.name));
    for (const stray of ["Deribit", "Coinbase International", "edgeX", "Pacifica", "Lighter RH"]) {
      if (declared.has(stray)) continue;
      // A bullet may say a venue is NOT on the bench; that sentence is the
      // one place the name is allowed, so check the enumerations only.
      const upToList = (cohortBullet as string).split("Both normalize")[0];
      expect(upToList, `${stray} is not on this bench`).not.toContain(stray);
      expect(spec.seo_intro ?? "", `${stray} is not on this bench`).not.toContain(
        stray,
      );
    }
  });
});
