import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { RpcHubChain } from "@/lib/rpc-hub-stats";

/**
 * The Archive column is measured on the public cohort only.
 *
 * `harnesses/rpc-keyed-latency` has no depth probe (no `eth_getBalance` at
 * head-N, no depth buckets), so `rpc_archive_*` carries no `tier` label and
 * the three API-key cohorts had a dash in every cell. A dash on this column
 * means "no provider on this chain serves archive", which is a claim about
 * the providers; the truth was "not measured on this cohort". So the column
 * is hidden where there is nothing behind it.
 *
 * Two things are pinned here: the predicate that decides, and the fact that
 * the header and the cell sit behind the same flag. Gating one and not the
 * other shifts every region column by one position, which reads as a wrong
 * number rather than as a broken table.
 */

/** Lifted from the component verbatim. */
const hasArchive = (rows: Pick<RpcHubChain, "bestArchiveDepthBlocks">[]) =>
  rows.some((r) => r.bestArchiveDepthBlocks != null);

describe("archive column visibility", () => {
  it("shows the column when any row was measured", () => {
    expect(
      hasArchive([
        { bestArchiveDepthBlocks: undefined },
        { bestArchiveDepthBlocks: 5_000_000 },
      ]),
    ).toBe(true);
  });

  it("hides it on a cohort where nothing is measured", () => {
    // The keyed / cold / websocket cohorts, every chain.
    expect(
      hasArchive([
        { bestArchiveDepthBlocks: undefined },
        { bestArchiveDepthBlocks: undefined },
      ]),
    ).toBe(false);
  });

  it("hides it rather than throwing on an empty cohort", () => {
    expect(hasArchive([])).toBe(false);
  });

  it("counts a depth of 0 as measured, not as absent", () => {
    // A provider that serves only the head block is a real answer, and
    // `!= null` keeps it where a truthiness test would drop it.
    expect(hasArchive([{ bestArchiveDepthBlocks: 0 }])).toBe(true);
  });
});

describe("the header and the cell are gated together", () => {
  const src = readFileSync("src/components/rpc-chains-leaderboard.tsx", "utf8");

  it("has exactly two JSX gates, the th and the td", () => {
    expect(src.match(/\{hasArchive && \(/g)?.length).toBe(2);
  });

  it("renders neither the header nor the cell ungated", () => {
    // Both strings are unique to the archive column; each must occur once,
    // and the gate count above is what keeps them behind the flag.
    expect(src.match(/sortKey === "archive"/g)?.length).toBe(1);
    expect(src.match(/\{fmtArchive\(/g)?.length).toBe(1);
  });

  it("spans the empty-search row over the columns actually drawn", () => {
    expect(src).toContain("colSpan={hasArchive ? 10 : 9}");
  });
});
