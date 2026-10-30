import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { MAX_STATIC_PANELS, staticLedgerPanels } from "@/lib/static-panels";
import type { LedgerColumn, MetricPanel } from "@/types/benchmark";

/**
 * Which columns the crawler-facing table carries.
 *
 * The table used to take the first three panels in spec order, which on
 * bench 311 meant three getLogs readings and none of the trace, archive or
 * receipts cells its title, H1 and description promise. A reader with
 * JavaScript saw all nine; GPTBot, OAI-SearchBot, PerplexityBot and
 * Claude-User saw a page that answered a different question from the one it
 * advertises (SEO audit 2026-10-30, blocker 1).
 */
const panel = (id: string, values: Record<string, number> = { a: 1 }) =>
  ({ id, label: id, metric: "x", unit: "pct", higherIsBetter: true, values }) as unknown as MetricPanel;
const col = (p: string) => ({ label: p, panel: p }) as LedgerColumn;

describe("the panels the served table shows", () => {
  test("follows the spec's declared columns, in their order", () => {
    const panels = [panel("getlogs_a"), panel("getlogs_b"), panel("getlogs_c"), panel("trace"), panel("archive")];
    const got = staticLedgerPanels(panels, [col("trace"), col("archive"), col("getlogs_a")]);
    expect(got.map((p) => p.id)).toEqual(["trace", "archive", "getlogs_a"]);
  });

  test("is not capped at three when the spec declares more", () => {
    // The declared list is what the schema caps, at nine. This constant is
    // the fallback's rule, not a ceiling on a spec that named its table.
    const panels = Array.from({ length: 8 }, (_, i) => panel(`p${i}`));
    const got = staticLedgerPanels(panels, panels.map((p) => col(p.id)));
    expect(got.length).toBe(8);
    expect(got.length).toBeGreaterThan(MAX_STATIC_PANELS);
  });

  test("keeps the three-panel rule for a spec that declares no columns", () => {
    const panels = Array.from({ length: 10 }, (_, i) => panel(`p${i}`));
    expect(staticLedgerPanels(panels, undefined).length).toBe(MAX_STATIC_PANELS);
    expect(staticLedgerPanels(panels, []).length).toBe(MAX_STATIC_PANELS);
  });

  test("drops a declared column whose panel has no values", () => {
    // Rendering it would print a column of dashes with a header promising
    // a reading, which is worse than one fewer column.
    const panels = [panel("trace"), panel("empty", {}), panel("archive")];
    const got = staticLedgerPanels(panels, [col("trace"), col("empty"), col("archive")]);
    expect(got.map((p) => p.id)).toEqual(["trace", "archive"]);
  });

  test("falls back when every declared panel is missing, rather than rendering nothing", () => {
    const panels = [panel("a"), panel("b")];
    const got = staticLedgerPanels(panels, [col("gone"), col("also-gone")]);
    expect(got.map((p) => p.id)).toEqual(["a", "b"]);
  });

  test("ignores columns bound to a headline slot instead of a panel", () => {
    const panels = [panel("trace")];
    const cols = [{ label: "APIs served", slot: "p50" } as LedgerColumn, col("trace")];
    expect(staticLedgerPanels(panels, cols).map((p) => p.id)).toEqual(["trace"]);
  });
});

describe("bench 311, the spec that found this", () => {
  // Read from the real spec, so this fails if someone reorders its columns
  // away from what the page's title promises.
  const spec = load(
    readFileSync(join(import.meta.dir, "../../benchmarks/rpc-api-coverage.yml"), "utf8"),
  ) as { metric_panels: { id: string }[]; ledger_columns: { panel?: string }[] };

  test("declares trace, receipts and archive columns that the first three panels do not reach", () => {
    const declared = spec.ledger_columns.map((c) => c.panel).filter(Boolean) as string[];
    for (const id of ["api_debug_tracetransaction", "api_trace_block", "api_getblockreceipts", "api_archive_5m"]) {
      expect(declared).toContain(id);
    }
    // The point of the fix: those ids are NOT in the first three panels, so
    // the old rule could not have shown them.
    const firstThree = spec.metric_panels.slice(0, MAX_STATIC_PANELS).map((p) => p.id);
    expect(firstThree).not.toContain("api_trace_block");
    expect(firstThree).not.toContain("api_archive_5m");
  });

  test("the declared columns resolve against the spec's own panel ids", () => {
    const ids = new Set(spec.metric_panels.map((p) => p.id));
    for (const c of spec.ledger_columns) {
      if (c.panel) expect(ids).toContain(c.panel);
    }
  });
});
