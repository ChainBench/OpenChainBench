import Link from "next/link";
import {
  serverWalletCurves,
  serverWalletRankAt,
  serverWalletWorkload,
} from "@/lib/server-wallet-cost-curve";

/**
 * One vendor's monthly bill for every server and agent wallet scenario of
 * bench 310, on its product page. Reads the same committed curve as the
 * bench's calculator.
 */
export function ServerWalletVendorPricing({ slug, name }: { slug: string; name: string }) {
  const file = serverWalletCurves();
  if (!file) return null;
  const vendor = file.scenarios[0]?.providers.find((p) => p.slug === slug);
  if (!vendor) return null;
  return (
    <section className="mt-10" aria-labelledby="server-wallet-pricing">
      <h2 id="server-wallet-pricing" className="text-xl font-semibold tracking-tight text-ink">
        {name} server and agent wallet pricing
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
        {name} bills on {lowerFirst(vendor.unit)}. Its monthly bill for wallets a backend or an AI
        agent holds, on its cheapest self-serve plan, from its published prices as of{" "}
        {file.catalogueAsOf}, with its rank among the vendors priced. Gas is excluded. Any other size
        is on the{" "}
        <Link href="/benchmarks/server-wallet-cost#calculator" className="underline decoration-ink/25 underline-offset-2 hover:decoration-ink/60">
          server wallet cost calculator
        </Link>
        .
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="py-2 pr-3 text-left font-medium label-mono text-ink-faint">Scenario</th>
              {["Small", "Medium", "Large"].map((l) => (
                <th key={l} className="px-2 py-2 text-left font-medium label-mono text-ink-faint">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {file.scenarios.map((s) => (
              <tr key={s.id}>
                <th scope="row" className="border-t border-rule py-3 pr-3 text-left align-top font-medium text-ink">
                  {s.label}
                </th>
                {s.sizes.map((z) => {
                  const { priced, unpriced } = serverWalletRankAt(s.id, z.x);
                  const row = priced.find((r) => r.slug === slug);
                  const { wallets, tx } = serverWalletWorkload(s, z.x);
                  const head = `${z.x.toLocaleString("en-US")} ${s.axis}`;
                  const detail = `${wallets.toLocaleString("en-US")} wallets, ${tx.toLocaleString("en-US")} tx`;
                  if (!row) {
                    const why = unpriced.find((r) => r.slug === slug)?.reason ?? "not priced";
                    return (
                      <td key={z.id} className="border-t border-rule px-2 py-3 align-top">
                        <span className="block text-[11px] text-ink-faint">{head}</span>
                        <span className="block text-[11px] leading-snug text-ink-muted">No self-serve price: {why}</span>
                      </td>
                    );
                  }
                  const c = Math.round((row.usd ?? 0) * 100);
                  const rank = 1 + priced.filter((r) => Math.round((r.usd ?? 0) * 100) < c).length;
                  const bound = row.verified ? "" : row.bound === "upper" ? " · at most" : row.bound === "lower" ? " · at least" : " · ambiguous price";
                  return (
                    <td key={z.id} className="border-t border-rule px-2 py-3 align-top" title={detail}>
                      <span className="block text-[11px] text-ink-faint">{head}</span>
                      <span className="block font-semibold tabular-nums text-ink">
                        {fmtBill(row.usd)}
                        <span className="text-xs font-normal text-ink-faint">/mo</span>
                      </span>
                      <span className="block text-[11px] text-ink-faint">
                        {row.planName} · #{rank} of {priced.length}
                        {bound}
                      </span>
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

/** The vendor's bill and rank on bench 310's headline cell, for metadata. */
export function serverWalletVendorHeadline(slug: string): { usd: number; rank: number; of: number; label: string } | { reason: string; of: number; label: string } | null {
  const file = serverWalletCurves();
  if (!file) return null;
  const s = file.scenarios.find((v) => v.id === file.headline.scenario);
  const z = s?.sizes.find((v) => v.id === file.headline.size);
  if (!s || !z) return null;
  const label = `${z.x.toLocaleString("en-US")} ${s.axis}`;
  const { priced, unpriced } = serverWalletRankAt(s.id, z.x);
  const row = priced.find((r) => r.slug === slug);
  if (row && row.usd !== null) {
    const c = Math.round(row.usd * 100);
    return { usd: row.usd, rank: 1 + priced.filter((r) => Math.round((r.usd ?? 0) * 100) < c).length, of: priced.length, label };
  }
  const u = unpriced.find((r) => r.slug === slug);
  return u ? { reason: u.reason, of: priced.length, label } : null;
}

function fmtBill(usd: number | null): string {
  if (usd === null) return "-";
  const c = Math.round(usd * 100) / 100;
  if (c === 0) return "$0";
  if (c < 100) return `$${c.toFixed(2).replace(/\.00$/, "")}`;
  return `$${Math.round(c).toLocaleString("en-US")}`;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export { fmtBill as fmtServerWalletBill };
