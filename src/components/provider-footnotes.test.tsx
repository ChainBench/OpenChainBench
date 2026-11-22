import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { draftPlaceholderForSpec, loadSpecsUncached } from "@/lib/materialize/load";
import { LedgerTable } from "./ledger-table";
import type { Benchmark } from "@/types/benchmark";

async function perpFees(): Promise<Benchmark> {
  const spec = (await loadSpecsUncached()).find((s) => s.slug === "perp-fees");
  if (!spec) throw new Error("perp-fees spec missing");
  const draft = draftPlaceholderForSpec(spec);
  return {
    ...draft,
    status: "live",
    results: draft.results.map((r, i) => ({
      ...r,
      ms: { p50: 1 + i, p90: 1 + i, p99: 1 + i, mean: 1 + i },
      successRate: 100,
    })),
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
});
