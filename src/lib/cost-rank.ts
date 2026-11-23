/**
 * The one ranking rule of the pricing benches with a bound (310, 312), shared
 * by the calculator, the product-page table, the product metadata and the
 * harness (`floorsThatWouldLead` in harnesses/server-wallet-cost and
 * harnesses/paymaster-cost publish eligible=0 for the same rows).
 *
 * Every priced row is ranked on the cent, ties sharing a rank, EXCEPT an
 * "at least" price (a lower bound) at or under the cheapest price that holds:
 * ranking it would put a rank above the vendor the calculator names, on a
 * figure the vendor may well exceed. A lower bound above that price keeps
 * its place, as the ledger gives it.
 *
 * Before 2026-10-30 the product table ranked only the prices that hold, so
 * /products/portal read "#8 of 8" in its bench list and "#6 of 6" in the
 * table under it (audit 2026-10-30).
 */

export type BoundedRow = { usd: number | null; verified: boolean; bound: "upper" | "lower" | "" };

const cents = (v: number | null) => Math.round((v ?? 0) * 100);

export function costRanks<R extends BoundedRow>(priced: R[]): {
  /** The first price that holds under every reading, which may be named. */
  leader: R | undefined;
  /** Lower bounds at or under the leader: listed, not ranked. */
  floors: R[];
  ranked: R[];
  /** Competition rank among `ranked`, 0 for a floor or a row not priced. */
  rankOf: (row: R) => number;
} {
  const leader = priced.find((r) => r.verified || r.bound === "upper");
  const floors = leader
    ? priced.filter((r) => !r.verified && r.bound === "lower" && cents(r.usd) <= cents(leader.usd))
    : [];
  const ranked = priced.filter((r) => !floors.includes(r));
  const rankOf = (row: R) => {
    if (!ranked.includes(row)) return 0;
    const c = cents(row.usd);
    return 1 + ranked.filter((r) => cents(r.usd) < c).length;
  };
  return { leader, floors, ranked, rankOf };
}
