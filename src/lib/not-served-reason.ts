import { walletCostCurves, walletCostRankAt } from "@/lib/wallet-cost-curve";
import { serverWalletCurves, serverWalletRankAt } from "@/lib/server-wallet-cost-curve";

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
  if (benchSlug === "server-wallet-cost") return serverReason(providerSlug, filters);
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

/** Bench 310: kind is the scenario, bucket the size id of that scenario. */
function serverReason(providerSlug: string, filters: Record<string, string | undefined>): string | null {
  const f = serverWalletCurves();
  if (!f) return null;
  const kind = filters.kind && filters.kind !== "all" ? filters.kind : f.headline.scenario;
  const size = filters.bucket && filters.bucket !== "all" ? filters.bucket : f.headline.size;
  const s = f.scenarios.find((v) => v.id === kind);
  const x = s?.sizes.find((z) => z.id === size)?.x;
  if (!s || x === undefined) return null;
  const row = serverWalletRankAt(s.id, x).unpriced.find(
    (r) => r.slug.toLowerCase() === providerSlug.toLowerCase(),
  );
  return row?.reason || null;
}

/**
 * Why a priced row is published unranked, where the bench can say better
 * than "Provisional". Bench 310: an "at least" price that would rank first.
 */
export function rankGateReason(
  benchSlug: string,
  providerSlug: string,
  filters: Record<string, string | undefined>,
  gated?: { successRate?: number; sampleSize?: number },
): string | null {
  if (benchSlug === "rpc-api-coverage") return coverageRankReason(gated);
  if (benchSlug !== "server-wallet-cost") return null;
  const f = serverWalletCurves();
  if (!f) return null;
  const kind = filters.kind && filters.kind !== "all" ? filters.kind : f.headline.scenario;
  const size = filters.bucket && filters.bucket !== "all" ? filters.bucket : f.headline.size;
  const s = f.scenarios.find((v) => v.id === kind);
  const x = s?.sizes.find((z) => z.id === size)?.x;
  if (!s || x === undefined) return null;
  const row = serverWalletRankAt(s.id, x).priced.find(
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
 * this bench can only read 0 for one reason, which is that we obtained verdicts
 * on fewer than half the cells we asked of that provider.
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
  // verdicts over cells asked, which is exactly the quantity the gate reads.
  // Falls back to the bare cause rather than to a number we do not have.
  if (share == null || !Number.isFinite(share)) {
    return "our key was refused on most cells";
  }
  return `our key answered only ${Math.round(share)}% of cells`;
}
