import Link from "next/link";
import { walletCostCurves, walletCostRankAt } from "@/lib/wallet-cost-curve";

/**
 * One embedded wallet vendor's monthly bill for every profile and app size
 * bench 309 publishes, on that vendor's product page.
 *
 * Without it the page carried a single figure, the consumer app at 10,000
 * users, with no size beside it: "Privy ranks #9 of 10 at $499", on a
 * vendor whose own card bands that plan at 2,500 to 9,999 users and whose
 * bill reaches $106,000 at 100,000 trading users (SEO audit 2026-10-29). It
 * reads the same committed curve as the bench's calculator, so the two
 * cannot disagree.
 */
export function WalletVendorPricing({ slug, name }: { slug: string; name: string }) {
  const file = walletCostCurves();
  if (!file) return null;
  const vendor = file.profiles[0]?.providers.find((p) => p.slug === slug);
  if (!vendor) return null;

  const cell = (profile: string, mau: number) => {
    const { priced, unpriced } = walletCostRankAt(profile, mau);
    const i = priced.findIndex((r) => r.slug === slug);
    if (i >= 0) return { row: priced[i], rank: rankOf(priced, priced[i].usd), of: priced.length };
    const u = unpriced.find((r) => r.slug === slug);
    return { reason: u?.reason ?? "not priced", of: priced.length };
  };

  return (
    <section className="mt-10" aria-labelledby="wallet-pricing">
      <h2 id="wallet-pricing" className="text-xl font-semibold tracking-tight text-ink">
        {name} pricing by app size
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
        {name} bills on {lowerFirst(vendor.unit)}. Below is its monthly bill on its cheapest
        self-serve plan for three kinds of app at three sizes, from its published prices as
        of {file.catalogueAsOf}, and its rank among the vendors priced at that size. Gas is
        excluded. Any other size is on the{" "}
        <Link href="/benchmarks/wallet-cost#calculator" className="underline decoration-ink/25 underline-offset-2 hover:decoration-ink/60">
          embedded wallet cost calculator
        </Link>
        .
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="py-2 pr-3 text-left font-medium label-mono text-ink-faint">App</th>
              {file.volumes.map((v) => (
                <th key={v.id} className="px-2 py-2 text-left font-medium label-mono text-ink-faint">
                  {v.mau.toLocaleString("en-US")} users
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {file.profiles.map((p) => (
              <tr key={p.id}>
                <th scope="row" className="border-t border-rule py-3 pr-3 text-left align-top font-medium text-ink">
                  {p.label}
                  <span className="block text-[11px] font-normal text-ink-faint">
                    {p.txPerUser} transactions a user
                  </span>
                </th>
                {file.volumes.map((v) => {
                  const c = cell(p.id, v.mau);
                  return (
                    <td key={v.id} className="border-t border-rule px-2 py-3 align-top">
                      {"row" in c && c.row ? (
                        <>
                          <span className="block font-semibold tabular-nums text-ink">
                            {fmtBill(c.row.usd)}
                            <span className="text-xs font-normal text-ink-faint">/mo</span>
                          </span>
                          <span className="block text-[11px] text-ink-faint">
                            {c.row.planName} · #{c.rank} of {c.of}
                            {!c.row.verified ? " · ambiguous price" : ""}
                          </span>
                        </>
                      ) : (
                        <span className="block text-[11px] leading-snug text-ink-muted">
                          No self-serve price: {"reason" in c ? c.reason : ""}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Competition rank on the cent: four vendors free at 1,000 users are all
 *  #1, not #1 to #4 in alphabetical order. */
function rankOf(priced: { usd: number | null }[], usd: number | null): number {
  const c = Math.round((usd ?? 0) * 100);
  return 1 + priced.filter((r) => Math.round((r.usd ?? 0) * 100) < c).length;
}

function fmtBill(usd: number | null): string {
  if (usd === null) return "-";
  const c = Math.round(usd * 100) / 100;
  if (c === 0) return "$0";
  // To the cent whenever there are cents: ranks are taken on the cent.
  return Number.isInteger(c)
    ? `$${c.toLocaleString("en-US")}`
    : `$${c.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** The vendor's bill and rank on the bench's headline cell, for metadata. */
export function walletVendorHeadline(slug: string): { usd: number; rank: number; of: number; verified: boolean } | { reason: string; of: number } | null {
  const file = walletCostCurves();
  if (!file) return null;
  const mau = file.volumes.find((v) => v.id === file.headline.volume)?.mau;
  if (mau === undefined) return null;
  const { priced, unpriced } = walletCostRankAt(file.headline.profile, mau);
  const i = priced.findIndex((r) => r.slug === slug);
  if (i >= 0 && priced[i].usd !== null) return { usd: priced[i].usd as number, rank: rankOf(priced, priced[i].usd), of: priced.length, verified: priced[i].verified };
  const u = unpriced.find((r) => r.slug === slug);
  return u ? { reason: u.reason, of: priced.length } : null;
}

export { fmtBill as fmtWalletBill };
