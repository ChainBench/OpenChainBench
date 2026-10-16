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
};

export function noFigureLabel(benchSlug: string): string {
  return NOT_SERVED[benchSlug] ?? "data warming up";
}
