/**
 * What a bench appearance says when the provider has no figure on the
 * bench's default view.
 *
 * "Data warming up" is right for a latency bench, where a missing figure is
 * a source that has not reported yet. On the two RPC cost benches it is the
 * opposite of true: the default view is the dapp mix on Ethereum, and a
 * provider with no number there (Syndica, Helius, Triton sell Solana only)
 * is not waiting for anything. Syndica leads two Solana cells of bench 282
 * while its product page said its data was warming up (audit 2026-10-16).
 */
const NOT_SERVED: Record<string, string> = {
  "rpc-cost": "no Ethereum dapp plan",
  "rpc-free-tier": "no free Ethereum dapp allowance",
  // Turnkey, ZeroDev and Crossmint publish no self-serve price for a
  // 10,000-user app, and Reown none for a trading app: that is the product,
  // not a source that has not reported. Worded without the size so it
  // holds on every profile and size tab (see NOT_SERVED_ON_EVERY_VIEW).
  "wallet-cost": "no self-serve price for this app size",
};

/**
 * Benches whose label above is true on every dimension tab, not only the
 * default view. On those the loader also lists the missing providers on
 * filtered views, with the label, instead of dropping them silently: the
 * trading tab of bench 309 returned nine rows and no word on why Reown,
 * Turnkey, ZeroDev and Crossmint were absent (audit 2026-10-29).
 *
 * rpc-cost is not here because its label names the Ethereum dapp mix, which
 * is false on its Solana tab.
 */
const NOT_SERVED_ON_EVERY_VIEW = new Set(["wallet-cost"]);

export function notServedOnEveryView(benchSlug: string): boolean {
  return NOT_SERVED_ON_EVERY_VIEW.has(benchSlug);
}

/** The label when a missing figure is a product fact on this bench, or null
 *  when it still means a source that has not reported. */
export function notServedLabel(benchSlug: string): string | null {
  return NOT_SERVED[benchSlug] ?? null;
}

export function noFigureLabel(benchSlug: string): string {
  return NOT_SERVED[benchSlug] ?? "data warming up";
}

/**
 * The rank slot beside that label. "Awaiting" promised a rank that is coming,
 * which on these two benches never comes: Helius, Syndica and Triton read
 * "no Ethereum dapp plan · awaiting" on their product pages while the bench
 * itself has Syndica first on two Solana cells (audit 2026-10-22). Where the
 * missing figure is a product fact, the slot says the provider is not ranked
 * on this view; elsewhere it is still a source that has not reported yet.
 */
export function noRankLabel(benchSlug: string): string {
  return benchSlug in NOT_SERVED ? "not ranked" : "awaiting";
}
