/**
 * Build-time manifest mapping each slug to its public logo path.
 *
 * Lookup is case-insensitive — the perp-fees bench uses uppercase chain
 * values like `ETH` / `BTC` while the L1 bench uses lowercase chain
 * provider slugs like `ethereum` / `bitcoin`. Both resolve to the same
 * file via aliasing.
 *
 * Anything not registered here falls back to the brand-colored chip with
 * initials (see <ProviderLogo>). Drop a new file in `public/logos/` and
 * add an entry here to wire it in.
 */

const RAW: Record<string, string> = {
  // ─── L1 chains ───
  ethereum: "/logos/ethereum.png",
  bitcoin: "/logos/bitcoin.png",
  solana: "/logos/solana.png",
  bnb: "/logos/bnb.png",
  avalanche: "/logos/avalanche.png",
  tron: "/logos/tron.png",
  sui: "/logos/sui.png",
  stellar: "/logos/stellar.png",
  ton: "/logos/ton.png",
  cardano: "/logos/cardano.png",
  litecoin: "/logos/litecoin.png",
  monero: "/logos/monero.png",
  xrp: "/logos/xrp.png",

  // ─── EVM L2s & sidechains ───
  base: "/logos/base.jpeg",
  arbitrum: "/logos/arbitrum.png",
  polygon: "/logos/polygon.png",
  optimism: "/logos/optimism.png",
};

// Asset-symbol aliases used by perp-fees as chain dimension values.
const ALIASES: Record<string, string> = {
  eth: "ethereum",
  btc: "bitcoin",
  sol: "solana",
};

export function logoPath(slug: string): string | null {
  const key = slug.toLowerCase();
  const aliased = ALIASES[key] ?? key;
  return RAW[aliased] ?? null;
}

/** True when a logo file is registered. Cheap check used by the chip
 * fallback to decide whether to try the `<img>` at all. */
export function hasLogo(slug: string): boolean {
  return logoPath(slug) !== null;
}
