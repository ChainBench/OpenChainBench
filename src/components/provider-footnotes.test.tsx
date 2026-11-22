import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { renderToStaticMarkup } from "react-dom/server";
import { draftPlaceholderForSpec, loadSpecsUncached } from "@/lib/materialize/load";
import { SpecSchema } from "@/lib/spec-schema";
import { LedgerTable } from "./ledger-table";
import { StaticLedger } from "./static-ledger";
import type { Benchmark } from "@/types/benchmark";

const NOTE = "orders reach the book late";
const MARK = "see the note above the table";

async function perpFees(): Promise<Benchmark> {
  const spec = (await loadSpecsUncached()).find((s) => s.slug === "perp-fees");
  if (!spec) throw new Error("perp-fees spec missing");
  return draftPlaceholderForSpec(spec);
}

async function measured(lighterP50 = 1): Promise<Benchmark> {
  const draft = await perpFees();
  return {
    ...draft,
    status: "live",
    sampleSize: 288,
    providerFootnotes: { lighter: NOTE },
    results: draft.results.map((r, i) => {
      const v = r.slug === "lighter" ? lighterP50 : 2 + i;
      return {
        ...r,
        ms: { p50: v, p90: v, p99: v, mean: v },
        successRate: 100,
        sampleSize: 288,
      };
    }),
  };
}

const markedRows = (html: string) =>
  html.split("<tr").filter((row) => row.includes(MARK));

describe("provider footnotes", () => {
  test("perp-fees carries the Lighter note from its spec", async () => {
    expect((await perpFees()).providerFootnotes?.lighter).toContain("300 ms");
  });

  test.each([
    ["interactive", (b: Benchmark) => <LedgerTable benchmark={b} />],
    ["static", (b: Benchmark) => <StaticLedger benchmark={b} />],
  ])("%s ledger: note above the table, mark on its row", async (_, render) => {
    const html = renderToStaticMarkup(render(await measured()));
    const note = html.indexOf(NOTE);
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(html.indexOf("<table"));
    const rows = markedRows(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(">Lighter<");
  });

  test("a row cut by Top N takes its note with it", async () => {
    const html = renderToStaticMarkup(
      <LedgerTable benchmark={await measured(999)} topN={3} />,
    );
    expect(html).not.toContain(NOTE);
    expect(markedRows(html)).toHaveLength(0);
  });

  test("an unresponsive row keeps its note and mark", async () => {
    const bench = await measured();
    const results = bench.results.map((r) =>
      r.slug === "lighter" ? { ...r, unresponsive: true, successRate: 0 } : r,
    );
    const html = renderToStaticMarkup(
      <LedgerTable benchmark={{ ...bench, results }} />,
    );
    expect(html).toContain(NOTE);
    expect(markedRows(html)).toHaveLength(1);
  });

  test("a footnote key that names no provider is refused", () => {
    const raw = yaml.load(
      readFileSync(join(process.cwd(), "benchmarks/perp-fees.yml"), "utf8"),
    ) as Record<string, unknown>;
    raw.provider_footnotes = { ligther: "typo" };
    const parsed = SpecSchema.safeParse(raw);
    const paths = parsed.success
      ? []
      : parsed.error.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(["provider_footnotes.ligther"]);
  });
});
