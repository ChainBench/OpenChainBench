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
