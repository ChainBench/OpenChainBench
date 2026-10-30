import { walletCostCurves, walletCostRankAt } from "@/lib/wallet-cost-curve";
import { serverWalletCurves, serverWalletRankAt } from "@/lib/server-wallet-cost-curve";

/**
 * `{{cell:<kind>:<size>:<field>}}` for the two pricing benches (309, 310):
 * a winner, a bill or a count in the findings and FAQ, read from the same
 * curve the calculator reads instead of typed by hand.
 *
 * Typed copy went stale twice in two days: "Dynamic leads all three at $724"
 * survived a correction that made Dynamic $4,999, and "Reown is cheapest"
 * has no dollar figure for the prose check to catch (SEO audit 2026-10-30).
 *
 * kind and size are the curve's own ids: bench 309 a profile (consumer,
 * active, trading) and a volume (1k, 10k, 100k); bench 310 a scenario
 * (agents, bot, payouts) and a size (small, medium, large).
 *
 * Fields:
 *   best_name, best_usd      the vendor the calculator names cheapest, and its
 *                            bill ("$338 at most" when its price is an upper
 *                            bound); ties are joined ("Circle and Magic")
 *   second_name, second_usd  the next price that holds
 *   worst_name, worst_usd    the dearest priced vendor
 *   free_names, free_count   vendors at $0 whose price holds
 *   priced_count             vendors with a published price there
 *   spread                   dearest over cheapest, "152x" (empty if free)
 *   <vendor slug>            that vendor's bill there ("$9,975", "at least
 *                            $5,000"), or "no self-serve price"
 *
 * Returns null for an unknown bench, cell or field, so validate can refuse
 * the spec and the renderer can leave a visible placeholder.
 */

type Row = {
  slug: string;
  name: string;
  usd: number;
  /** Holds under every reading: verified, or an upper bound. */
  holds: boolean;
  reading: "" | "at most" | "at least" | "ambiguous";
};

type Cell = { priced: Row[]; unpriced: { slug: string; name: string }[] };

export const COST_CELL_BENCHES = new Set(["wallet-cost", "server-wallet-cost"]);

export const COST_CELL_FIELDS = new Set([
  "best_name",
  "best_usd",
  "second_name",
  "second_usd",
  "worst_name",
  "worst_usd",
  "free_names",
  "free_count",
  "priced_count",
  "spread",
]);

function cellOf(bench: string, kind: string, size: string): Cell | null {
  if (bench === "wallet-cost") {
    const f = walletCostCurves();
    const mau = f?.volumes.find((v) => v.id === size)?.mau;
    if (!f || mau === undefined || !f.profiles.some((p) => p.id === kind)) return null;
    const { priced, unpriced } = walletCostRankAt(kind, mau);
    return {
      priced: priced.map((r) => ({
        slug: r.slug,
        name: r.name,
        usd: r.usd ?? 0,
        holds: r.verified,
        reading: r.verified ? "" : "ambiguous",
      })),
      unpriced: unpriced.map((r) => ({ slug: r.slug, name: r.name })),
    };
  }
  if (bench === "server-wallet-cost") {
    const f = serverWalletCurves();
    const s = f?.scenarios.find((v) => v.id === kind);
    const x = s?.sizes.find((z) => z.id === size)?.x;
    if (!s || x === undefined) return null;
    const { priced, unpriced } = serverWalletRankAt(s.id, x);
    return {
      priced: priced.map((r) => ({
        slug: r.slug,
        name: r.name,
        usd: r.usd ?? 0,
        holds: r.verified || r.bound === "upper",
        reading: r.verified ? "" : r.bound === "upper" ? "at most" : r.bound === "lower" ? "at least" : "ambiguous",
      })),
      unpriced: unpriced.map((r) => ({ slug: r.slug, name: r.name })),
    };
  }
  return null;
}

const cents = (v: number) => Math.round(v * 100);

export function fmtCostUSD(v: number): string {
  const c = cents(v) / 100;
  if (c === 0) return "$0";
  return Number.isInteger(c)
    ? `$${c.toLocaleString("en-US")}`
    : `$${c.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bill(r: Row): string {
  const usd = fmtCostUSD(r.usd);
  if (r.reading === "at most") return `${usd} at most`;
  if (r.reading === "at least") return `at least ${usd}`;
  return usd;
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function costCell(bench: string, kind: string, size: string, field: string): string | null {
  const cell = cellOf(bench, kind, size);
  if (!cell) return null;
  // The calculator names a vendor cheapest only when its price holds under
  // every reading; the ledger and the grid rank the same way.
  const holds = cell.priced.filter((r) => r.holds);
  const best = holds[0];
  const tied = best ? holds.filter((r) => cents(r.usd) === cents(best.usd)) : [];
  const after = best ? holds.filter((r) => cents(r.usd) > cents(best.usd)) : [];
  const second = after[0];
  const secondTied = second ? after.filter((r) => cents(r.usd) === cents(second.usd)) : [];
  const worst = cell.priced.at(-1);
  switch (field) {
    case "best_name":
      return tied.length ? joinNames(tied.map((r) => r.name)) : "no vendor";
    case "best_usd":
      return best ? bill(best) : "no published price";
    case "second_name":
      return secondTied.length ? joinNames(secondTied.map((r) => r.name)) : "no other vendor";
    case "second_usd":
      return second ? bill(second) : "no published price";
    case "worst_name":
      return worst ? worst.name : "no vendor";
    case "worst_usd":
      return worst ? bill(worst) : "no published price";
    case "free_names": {
      const free = holds.filter((r) => cents(r.usd) === 0).map((r) => r.name);
      return free.length ? joinNames(free) : "no vendor";
    }
    case "free_count":
      return String(holds.filter((r) => cents(r.usd) === 0).length);
    case "priced_count":
      return String(cell.priced.length);
    case "spread":
      return best && worst && best.usd > 0 ? `${Math.round(worst.usd / best.usd)}x` : "";
    default: {
      // A vendor slug: that vendor's bill in this cell.
      const row = cell.priced.find((r) => r.slug === field);
      if (row) return bill(row);
      if (cell.unpriced.some((r) => r.slug === field)) return "no self-serve price";
      return null;
    }
  }
}

export const COST_CELL_RE = /\{\{\s*cell:([a-z0-9-]+):([a-z0-9-]+):([a-z0-9_-]+)\s*\}\}/gi;

/** Resolves every cell placeholder in `text` for `bench`; unknown ones stay. */
export function renderCostCells(text: string, bench: string): string {
  if (!COST_CELL_BENCHES.has(bench) || !text.includes("{{")) return text;
  return text.replace(COST_CELL_RE, (whole, kind: string, size: string, field: string) => {
    return costCell(bench, kind.toLowerCase(), size.toLowerCase(), field.toLowerCase()) ?? whole;
  });
}
