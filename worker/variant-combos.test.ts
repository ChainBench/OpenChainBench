import { describe, expect, test } from "bun:test";
import { variantCombos } from "./variant-combos";
import type { Spec } from "@/lib/spec-schema";

// The app never builds a filtered view on demand: loadBenchmarkFiltered
// reads the worker's blob, then Redis, then returns undefined and the
// variant route falls back to the aggregate. So a dimension the worker
// does not enumerate is not a missing tab, it is a tab that shows the
// unfiltered numbers under a filtered label.

const spec = (dimensions: Spec["dimensions"]): Spec =>
  ({ slug: "t", dimensions, providers: [] }) as unknown as Spec;

const sig = (f: Record<string, string | undefined>) =>
  Object.keys(f)
    .sort()
    .map((k) => `${k}=${f[k]}`)
    .join("&");

describe("variantCombos covers every declared dimension", () => {
  test("a bucket dimension produces its own variants", () => {
    const combos = variantCombos(
      spec({
        bucket: [
          { value: "all", label: "All sizes" },
          { value: "under25", label: "Under $25" },
          { value: "over250", label: "Over $250" },
        ],
      }),
    );
    const sigs = combos.map((c) => sig(c as Record<string, string>));
    expect(sigs).toContain("bucket=under25");
    expect(sigs).toContain("bucket=over250");
    expect(sigs).not.toContain("bucket=all"); // the aggregate is the "all" view
  });

  test("bucket is crossed with chain, so Solana + Under $25 exists", () => {
    const combos = variantCombos(
      spec({
        chain: [
          { value: "all", label: "All chains" },
          { value: "solana", label: "Solana" },
        ],
        bucket: [
          { value: "all", label: "All sizes" },
          { value: "under25", label: "Under $25" },
        ],
      }),
    );
    const sigs = combos.map((c) => sig(c as Record<string, string>));
    expect(sigs).toContain("bucket=under25&chain=solana");
    expect(sigs).toContain("chain=solana");
    expect(sigs).toContain("bucket=under25");
    expect(sigs.length).toBe(3); // 2x2 minus the aggregate
  });

  test("a spec with no bucket dimension is unchanged", () => {
    const combos = variantCombos(
      spec({ chain: [{ value: "all", label: "All" }, { value: "base", label: "Base" }] }),
    );
    expect(combos).toEqual([{ chain: "base" }]);
  });
});
