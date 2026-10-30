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
  gated?: { successRate?: number; sampleSize?: number },
): string | null {
  if (benchSlug === "rpc-api-coverage") return coverageRankReason(gated);
  const row = scenarioCell(benchSlug, filters)?.priced.find(
    (r) => r.slug.toLowerCase() === providerSlug.toLowerCase(),
  );
  if (!row || row.verified || row.bound !== "lower") return null;
  return "at least this: its page leaves a fee unpriced, so it is not ranked";
}

/**
 * Bench 311: the caption the generic path falls back to is "sample below the
 * ranking floor", which is true in the arithmetic and wrong in the cause. The
 * sample is small because our own key is refused on most of the chains it is
 * configured for, not because the bench has seen little traffic, and a reader
 * who knows other benches reads the generic wording as "this bench is young".
 *
 * Returned for every gated row rather than looked up per provider: the gate on
 * this bench can only read 0 for one reason, which is that recomputing the
 * provider's share with its unanswered cells credited at what the rest of the
 * cohort gets there moves it by more than one point. The cells were asked. The
 * verdicts are what is missing, and one of them is enough when it is a method
 * the cohort disagrees on.
 *
 * Kept to a badge's length on purpose. static-ledger renders this inline beside
 * the provider name at 11px uppercase with 0.14em tracking, so a sentence here
 * would set the column width for the whole table. It names the cause; the
 * success column beside it carries the size (21.43 % of cells answered against
 * 100 % for the ranked rows), and the methodology carries the argument.
 */
function coverageRankReason(row?: { successRate?: number }): string {
  const share = row?.successRate;
  // The share comes from the row, never typed: `success` on this bench is
  // verdicts over cells asked, so it is the size of what we could not ask.
  //
  // Phrased to stay true on EVERY gated view. On the all-chains tab the cause
  // really is a widely refused key (12 cells of 56). On a single chain tab the
  // same provider answered 6 of 7, and the gate fires because that one unasked
  // cell is the method the rest of the cohort refuses, so it decides the
  // position by itself. "refused on most cells" would be false there.
  if (share == null || !Number.isFinite(share)) {
    return "not answered on every cell, so it takes no rank";
  }
  // "asked on only N%" was the share answered, printed as the share asked.
  // Alchemy was asked on 56 cells of 56 and the badge read 21%; on the
  // HyperEVM tab it was asked on 7 of 7 and read 86%. We ask every cell,
  // every pass; what varies is how many come back (audit 2026-10-30).
  return `verdict on only ${Math.round(share)}% of cells`;
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
