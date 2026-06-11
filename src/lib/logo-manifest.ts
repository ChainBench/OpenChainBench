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
  celo: "/logos/celo.svg",
  opbnb: "/logos/bnb.png",
  aptos: "/logos/aptos.svg",
  sonic: "/logos/sonic.png",
  berachain: "/logos/berachain.png",

  // ─── Providers ───
  mobula: "/logos/mobula.svg",
  codex: "/logos/codex.svg",
  polymarket: "/logos/polymarket.png",
  bebop: "/logos/bebop.svg",
  kyberswap: "/logos/kyberswap.svg",
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
  raydium: "/logos/raydium.svg",
  openocean: "/logos/openocean.png",
  cow: "/logos/cow.png",
  enso: "/logos/enso.png",
  lighter: "/logos/lighter.svg",
  debridge: "/logos/debridge.svg",

  // ─── Public RPC providers ───
  publicnode: "/logos/publicnode.avif",
  drpc: "/logos/drpc.webp",
  "1rpc": "/logos/1rpc.svg",
  cloudflare: "/logos/cloudflare.svg",
  "base-official": "/logos/base.jpeg",
  binance: "/logos/bnb.png",
  lava: "/logos/lava.webp",
  nodies: "/logos/nodies.png",
  tenderly: "/logos/tenderly.svg",
  tonapi: "/logos/tonapi.png",
  meowrpc: "/logos/meowrpc.jpg",

  // ─── MEV / private mempools (gas-estimation, RPC capabilities) ───
  flashbots: "/logos/flashbots.svg",
  blocknative: "/logos/blocknative.svg",
  merkle: "/logos/merkle.svg",

  // ─── Block explorers / address-label providers ───
  walletexplorer: "/logos/walletexplorer.png",
  xrpscan: "/logos/xrpscan.png",
  oli: "/logos/oli.png",

  // ─── L1 chains (additions) ───
  hedera: "/logos/hedera.svg",

  // ─── Cosmos chains (token-deployment-cost bench) ───
  osmosis: "/logos/osmosis.svg",
  injective: "/logos/injective.svg",
  neutron: "/logos/neutron.svg",

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

  // ─── Solana transaction landing services (bench 016) ───
  jito: "/logos/jito.svg",
  nozomi: "/logos/nozomi.svg",
  bloxroute: "/logos/bloxroute.png",
  "0slot": "/logos/0slot.png",
  nextblock: "/logos/nextblock.png",
  astralane: "/logos/astralane.svg",
  solanavibestation: "/logos/solanavibestation.png",

  // ─── Buyback audit (bench 018) ───
  sky: "/logos/sky.svg",

  // ─── Oracle deviation (bench 025) — additional brand logos ───
  // (pairs alias to chain/asset logos in the ALIASES block below)
  chainlink: "/logos/chainlink.svg",
  dogecoin: "/logos/dogecoin.png",

  // ─── Data / API providers (alternatives + products pages) ───
  alchemy: "/logos/alchemy.svg",
  birdeye: "/logos/birdeye.png",
  bitquery: "/logos/bitquery.png",
  coingecko: "/logos/coingecko.webp",
  dune: "/logos/dune.png",
  "pump-portal": "/logos/pump-portal.svg",
  quicknode: "/logos/quicknode.svg",
  "the-graph": "/logos/the-graph.svg",

  // ─── network-coverage bench providers (bench № 005 expansion) ───
  coinpaprika: "/logos/coinpaprika.svg",
  covalent: "/logos/covalent.svg",
  coinstats: "/logos/coinstats.svg",

  // ─── Hyperliquid frontends (bench № 030) ───
  "phantom-perps": "/logos/phantom-perps.svg",
  axiom: "/logos/axiom.png",
  "pvp-trade": "/logos/pvp-trade.png",
  insilico: "/logos/insilico.svg",
  defiapp: "/logos/defiapp.svg",
  metamask: "/logos/metamask.svg",
  dexari: "/logos/dexari.png",
  okto: "/logos/okto.png",

  // ─── Hyperliquid HIP-3 deployers (bench № 035) ───
  xyz: "/logos/xyz.png",
  vntl: "/logos/vntl.png",
  cash: "/logos/dreamcash.png",
  km: "/logos/km.svg",
  hyna: "/logos/hyna.svg",
  flx: "/logos/flx.png",
  para: "/logos/para.jpg",

  // ─── Hyperliquid frontends registry expansion (8 → 60) ───
  "trust-wallet": "/logos/trust-wallet.png",
  sushi: "/logos/sushi.png",
  dreamcash: "/logos/dreamcash.png",
  "based-app": "/logos/based-app.png",
  perpmate: "/logos/perpmate.png",
  arena: "/logos/arena.png",
  minaraai: "/logos/minaraai.png",
  apexliquid: "/logos/apexliquid.png",
  coin98: "/logos/coin98.png",
  coinpilot: "/logos/coinpilot.png",
  echosync: "/logos/echosync.png",
  fomo: "/logos/fomo.png",
  gemwallet: "/logos/gemwallet.svg",
  "gtr-trade": "/logos/gtr-trade.png",
  hyprearn: "/logos/hyprearn.png",
  "legend-trade": "/logos/legend-trade.png",
  katoshi: "/logos/katoshi.svg",
  metascalp: "/logos/metascalp.svg",
  moontrader: "/logos/moontrader.svg",
  onekey: "/logos/onekey.png",
  pear: "/logos/pear.svg",
  rabby: "/logos/rabby.png",
  "ranger-finance": "/logos/ranger-finance.svg",
  senpi: "/logos/senpi.png",
  superx: "/logos/superx.avif",
  supurr: "/logos/supurr.svg",
  unigox: "/logos/unigox.svg",
  uxuy: "/logos/uxuy.svg",
  wunder: "/logos/wunder.png",
  grider: "/logos/grider.jpg",
  tradoor: "/logos/tradoor.svg",
  bullpenfi: "/logos/bullpen.svg",
  "dexly-trade": "/logos/dexly-trade.svg",
  hyperdash: "/logos/hyperdash.jpg",
  infinex: "/logos/infinex.jpg",
  liminal: "/logos/liminal.jpg",
  "liquid-perps": "/logos/liquid-perps.jpg",
  "lit-trade": "/logos/lit-trade.png",
  lootbase: "/logos/lootbase.png",
  "mass-dot-money": "/logos/mass-dot-money.svg",
  moonbot: "/logos/moonbot.png",
  rainbow: "/logos/rainbow.png",
  supercexy: "/logos/supercexy.svg",
  superstack: "/logos/superstack.jpg",
  "wallet-v": "/logos/wallet-v.png",
  "xtrade-protocol": "/logos/xtrade-protocol.jpg",
  "taco-trade": "/logos/taco-trade.jpg",
  silhouette: "/logos/silhouette.jpg",
  "tread-fi": "/logos/tread-fi.jpg",
  flowbot: "/logos/flowbot.jpg",
  "nautilus-trader": "/logos/nautilus-trader.png",
  blink: "/logos/blink.png",
};

// Asset-symbol aliases used by perp-fees as chain dimension values.
// Also: provider-slug aliases when two providers share branding (e.g.
// the publicnode-feehistory gas oracle is the same brand as the
// publicnode RPC service).
const ALIASES: Record<string, string> = {
  eth: "ethereum",
  btc: "bitcoin",
  sol: "solana",
  bsc: "bnb",
  "publicnode-feehistory": "publicnode",

  // Oracle-deviation bench exposes one provider per trading pair (e.g.
  // `btc-usd`). The page describes the underlying asset, so alias each
  // pair slug to the existing chain/asset logo rather than ship a new
  // file. `matic-usd` points at polygon — the chain renamed MATIC to
  // POL in Sep 2024 but the slug + chain logo cover the asset.
  "btc-usd": "bitcoin",
  "eth-usd": "ethereum",
  "sol-usd": "solana",
  "bnb-usd": "bnb",
  "xrp-usd": "xrp",
  "ada-usd": "cardano",
  "doge-usd": "dogecoin",
  "avax-usd": "avalanche",
  "link-usd": "chainlink",
  "matic-usd": "polygon",
  // helius-sender shares brand with the Helius RPC entry
  "helius-sender": "helius",

  // Official-RPC providers reuse the chain's brand mark (RPC capabilities
  // bench distinguishes the chain's own endpoint from third-party RPCs).
  "arbitrum-official": "arbitrum",
  "avalanche-official": "avalanche",
  "optimism-official": "optimism",

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
