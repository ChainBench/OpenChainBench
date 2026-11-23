import { walletCostCurves, walletCostRankAt } from "@/lib/wallet-cost-curve";
import { serverWalletCurves, serverWalletRankAt, type ServerWalletRow } from "@/lib/server-wallet-cost-curve";
import { paymasterCurves, paymasterRankAt } from "@/lib/paymaster-cost-curve";

/**
 * The cell a view names on the scenario benches (310 server wallets, 312
 * paymasters): kind is the scenario, bucket the size id of that scenario.
 * Both curves have the same shape, so one reader serves them.
 */
function scenarioCell(
  benchSlug: string,
  filters: Record<string, string | undefined>,
): { priced: ServerWalletRow[]; unpriced: ServerWalletRow[] } | null {
  const reader =
    benchSlug === "server-wallet-cost"
      ? { f: serverWalletCurves(), rank: serverWalletRankAt }
      : benchSlug === "paymaster-cost"
        ? { f: paymasterCurves(), rank: paymasterRankAt }
        : null;
  const f = reader?.f;
  if (!reader || !f) return null;
  const kind = filters.kind && filters.kind !== "all" ? filters.kind : f.headline.scenario;
  const size = filters.bucket && filters.bucket !== "all" ? filters.bucket : f.headline.size;
  const s = f.scenarios.find((v) => v.id === kind);
  const x = s?.sizes.find((z) => z.id === size)?.x;
  if (!s || x === undefined) return null;
  return reader.rank(s.id, x);
}

/**
 * Why a provider has no figure on one view of a bench, in that provider's
 * own terms, when the bench can say so.
 *
 * bench 309 knows exactly why each vendor is unpriced on each profile and
 * size: the harness writes the reason into the curve the site ships ("Pro
 * stops at 2,000 wallets; Enterprise has no published price", "Reown's page
 * says exchange, custodian and payments platforms need a custom plan"). A
 * single label per bench could not be true everywhere: it told readers of
 * the trading tab that Reown had no price "for this app size" when the same
 * Reown prices 10,000 users at $214 on the other profiles (audit
 * 2026-10-29).
 *
 * `filters` are the view's active dimension values (absent or "all" means
 * the axis's headline value). Returns null when the bench has no per-view
 * reason or the provider is priced on that view, so callers fall back to
 * the bench-wide label.
 */
export function notServedReason(
  benchSlug: string,
  providerSlug: string,
  filters: Record<string, string | undefined>,
): string | null {
  if (benchSlug === "server-wallet-cost" || benchSlug === "paymaster-cost") {
    const row = scenarioCell(benchSlug, filters)?.unpriced.find(
      (r) => r.slug.toLowerCase() === providerSlug.toLowerCase(),
    );
    return row?.reason || null;
  }
  if (benchSlug !== "wallet-cost") return null;
  const f = walletCostCurves();
  if (!f) return null;
  const kind = filters.kind && filters.kind !== "all" ? filters.kind : f.headline.profile;
  const bucket = filters.bucket && filters.bucket !== "all" ? filters.bucket : f.headline.volume;
  const mau = f.volumes.find((v) => v.id === bucket)?.mau;
  if (mau === undefined) return null;
  const row = walletCostRankAt(kind, mau).unpriced.find(
    (r) => r.slug.toLowerCase() === providerSlug.toLowerCase(),
  );
  return row?.reason || null;
}

/**
 * Why a priced row is published unranked, where the bench can say better
 * than "Provisional". Benches 310 and 312: an "at least" price that would
 * rank first.
 */
export function rankGateReason(
  benchSlug: string,
  providerSlug: string,
  filters: Record<string, string | undefined>,
): string | null {
  // The `gated` row argument and the coverage reason that read it left with
  // bench 311 on 2026-11-02, when its capability matrix moved onto the eight
  // chain RPC pages. Those pages rank on latency and publish capability as
  // columns, so no rank gate asks this function about coverage any more.
  //
  // The lesson is worth keeping even though the code is not. That badge read
  // "asked on only 21% of cells" for a provider asked on 56 cells of 56 and
  // answered on 12: it printed the share ANSWERED as the share ASKED. We ask
  // every cell every pass; what varies is how many come back. If a reason
  // string is ever added here again, make it name the quantity it actually
  // holds.

  const row = scenarioCell(benchSlug, filters)?.priced.find(
    (r) => r.slug.toLowerCase() === providerSlug.toLowerCase(),
  );
  if (!row || row.verified || row.bound !== "lower") return null;
  return "at least this: its page leaves a fee unpriced, so it is not ranked";
}

/**
 * How to read a priced row's bill on the two pricing benches, so the ledger
 * carries the same "at most" / "at least" the calculator shows (audit
 * 2026-10-30: the ledger printed bounded bills as plain numbers). Bench 309
 * has no bound, so an uncertain price there reads "ambiguous price".
 */
export function priceReading(
  benchSlug: string,
  providerSlug: string,
  filters: Record<string, string | undefined>,
): string | null {
  const slug = providerSlug.toLowerCase();
  if (benchSlug === "server-wallet-cost" || benchSlug === "paymaster-cost") {
    const row = scenarioCell(benchSlug, filters)?.priced.find((r) => r.slug.toLowerCase() === slug);
    if (!row || row.verified) return null;
    return row.bound === "upper" ? "at most" : row.bound === "lower" ? "at least" : "ambiguous price";
  }
  if (benchSlug === "wallet-cost") {
    const f = walletCostCurves();
    if (!f) return null;
    const kind = filters.kind && filters.kind !== "all" ? filters.kind : f.headline.profile;
    const bucket = filters.bucket && filters.bucket !== "all" ? filters.bucket : f.headline.volume;
    const mau = f.volumes.find((v) => v.id === bucket)?.mau;
    if (mau === undefined) return null;
    const row = walletCostRankAt(kind, mau).priced.find((r) => r.slug.toLowerCase() === slug);
    return row && !row.verified ? "ambiguous price" : null;
  }
  return null;
}
