/**
 * Per-chain block-explorer transaction URL builder.
 *
 * Used by the live feed to make each swap row clickable so users can
 * audit the on-chain trade themselves. Falls back to null for chains
 * we haven't mapped - the row stays rendered but non-clickable.
 */

const TX_URL: Record<string, (hash: string) => string> = {
  ethereum: (h) => `https://etherscan.io/tx/${h}`,
  solana: (h) => `https://solscan.io/tx/${h}`,
  base: (h) => `https://basescan.org/tx/${h}`,
  bnb: (h) => `https://bscscan.com/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
};

export function explorerTxUrl(chain: string | undefined, hash: string | undefined): string | null {
  if (!chain || !hash) return null;
  const builder = TX_URL[chain.toLowerCase()];
  return builder ? builder(hash) : null;
}
