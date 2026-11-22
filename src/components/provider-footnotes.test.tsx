import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { draftPlaceholderForSpec, loadSpecsUncached } from "@/lib/materialize/load";
import { BenchInfobox } from "./bench-infobox";
import { LedgerTable } from "./ledger-table";
import { RankedBarChart } from "./ranked-bar-chart";
import type { Benchmark } from "@/types/benchmark";

async function perpFees(leaderSlug?: string): Promise<Benchmark> {
  const spec = (await loadSpecsUncached()).find((s) => s.slug === "perp-fees");
  if (!spec) throw new Error("perp-fees spec missing");
  const draft = draftPlaceholderForSpec(spec);
  return {
    ...draft,
    status: "live",
    results: draft.results.map((r, i) => {
      const v = r.slug === leaderSlug ? 0.5 : 1 + i;
      return {
        ...r,
        ms: { p50: v, p90: v, p99: v, mean: v },
        successRate: 100,
      };
    }),
  };
}

describe("perp-fees ledger", () => {
  test("marks Lighter and explains it above the table", async () => {
    const html = renderToStaticMarkup(<LedgerTable benchmark={await perpFees()} />);
    const note = html.indexOf("300 ms late");
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(html.indexOf("<table"));
    const marked = html.split("<tr").filter((row) => row.includes("see the note above"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain(">Lighter<");
  });

  test.each([
    ["lighter", 2],
    ["hyperliquid", 0],
  ])("at a glance marks the leader %s %i times", async (slug, marks) => {
    const html = renderToStaticMarkup(
      <BenchInfobox benchmark={await perpFees(slug)} />,
    );
    expect(html.split("see the note above").length - 1).toBe(marks);
  });

  test("the ranked chart marks the Lighter bar", async () => {
    const html = renderToStaticMarkup(
      <RankedBarChart benchmark={await perpFees()} />,
    );
    const marked = html
      .split('role="button"')
      .filter((row) => row.includes("see the note above"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain(">Lighter<");
  });
});
