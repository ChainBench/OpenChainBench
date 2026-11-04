import { describe, expect, test } from "bun:test";
import { rankGateLabel } from "@/lib/rank-gate";

const RANKED = "abs(a - b) < bool 1";

describe("the rank gate", () => {
  test("ranks a row whose gate reads above zero", () => {
    expect(rankGateLabel(RANKED, 1)).toBeUndefined();
  });

  test("holds back a row whose gate reads zero", () => {
    expect(rankGateLabel(RANKED, 0)).toBe("Provisional");
  });

  test("fails CLOSED when the gate could not be read", () => {
    // This is the whole point. `prom.scalar` returns null for a query that
    // errored and for one that matched nothing, and the open version read
    // both as "nothing to report", so a single timed-out query promoted the
    // row the gate existed to hold back. On bench 311 that ranked Alchemy
    // first at 12 of 12 cells, above BlockMachine's 47 of 49.
    expect(rankGateLabel(RANKED, null)).toBe("Provisional");
    expect(rankGateLabel(RANKED, undefined)).toBe("Provisional");
  });

  test("treats a non-finite reading as unread rather than as a pass", () => {
    // A division by a zero denominator reaches here as Infinity or NaN, and
    // Infinity > 0 would have ranked it.
    expect(rankGateLabel(RANKED, Number.NaN)).toBe("Provisional");
    expect(rankGateLabel(RANKED, Number.POSITIVE_INFINITY)).toBe("Provisional");
  });

  test("says nothing at all about a spec that declares no gate", () => {
    // 224 benches of 261 do not declare `ranked`. None of them may acquire a
    // Provisional label from a gate they never asked for.
    expect(rankGateLabel(undefined, null)).toBeUndefined();
    expect(rankGateLabel(undefined, 0)).toBeUndefined();
    expect(rankGateLabel("", null)).toBeUndefined();
  });
});
