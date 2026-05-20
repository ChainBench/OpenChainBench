/**
 * Build-time manifest mapping each slug to its public logo path.
 *
 * Lookup is case-insensitive - the perp-fees bench uses uppercase chain
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
  xrp: "/logos/xrp.jpg",

  // ─── EVM L2s & sidechains ───
  base: "/logos/base.jpeg",
  arbitrum: "/logos/arbitrum.png",
  polygon: "/logos/polygon.png",
  optimism: "/logos/optimism.png",
  linea: "/logos/linea.png",
  mantle: "/logos/mantle.svg",
  blast: "/logos/blast.png",
  scroll: "/logos/scroll.png",
  zksync: "/logos/zksync.png",
  sonic: "/logos/sonic.png",
  berachain: "/logos/berachain.png",

  // ─── Providers ───
  mobula: "/logos/mobula.svg",
  codex: "/logos/codex.svg",
  relay: "/logos/relay.svg",
  lifi: "/logos/lifi.png",
  geckoterminal: "/logos/geckoterminal.png",
  gains: "/logos/gains.png",
  blockscout: "/logos/blockscout.svg",
  gmx: "/logos/gmx.svg",
  hyperliquid: "/logos/hyperliquid.png",
  helius: "/logos/helius.svg",
  dydx: "/logos/dydx.svg",
  moralis: "/logos/moralis.png",
  stellarexpert: "/logos/stellarexpert.png",
  jupiter: "/logos/jupiter.png",
  lighter: "/logos/lighter.svg",
  debridge: "/logos/debridge.svg",

  // ─── Public RPC providers ───
  publicnode: "/logos/publicnode.avif",
  drpc: "/logos/drpc.webp",
  "1rpc": "/logos/1rpc.svg",
  cloudflare: "/logos/cloudflare.svg",
  "base-official": "/logos/base.jpeg",
  binance: "/logos/bnb.png",

  // ─── Gas oracles ───
  etherscan: "/logos/etherscan.svg",
  owlracle: "/logos/owlracle.webp",
  // publicnode-feehistory aliased to publicnode below (same brand)

  // ─── Stablecoins ───
  usdc: "/logos/usdc.png",
  usdt: "/logos/usdt.svg",
  dai: "/logos/dai.png",
  fdusd: "/logos/fdusd.png",
  usde: "/logos/usde.png",

  // ─── L2 chains (additions) ───
  taiko: "/logos/taiko.png",
};

// Asset-symbol aliases used by perp-fees as chain dimension values.
// Also: provider-slug aliases when two providers share branding (e.g.
// the publicnode-feehistory gas oracle is the same brand as the
// publicnode RPC service).
const ALIASES: Record<string, string> = {
  eth: "ethereum",
  btc: "bitcoin",
  sol: "solana",
  "publicnode-feehistory": "publicnode",
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
