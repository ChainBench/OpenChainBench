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
  gram: "/logos/ton.svg",
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
  monad: "/logos/monad.png",
  across: "/logos/across.png",
  liquid8: "/logos/pocket-protector.jpg",
  megaeth: "/logos/megaeth.png",
  robinhood: "/logos/robinhood.png",
  onfinality: "/logos/onfinality.png",
  berachain: "/logos/berachain.png",

  // ─── Providers ───
  mobula: "/logos/mobula.svg",
  codex: "/logos/codex.svg",
  predexon: "/logos/predexon.svg",
  polymarket: "/logos/polymarket.png",
  kalshi: "/logos/kalshi.jpg",
  limitless: "/logos/limitless.png",
  manifold: "/logos/manifold.svg",
  myriad: "/logos/myriad.png",

  // ─── Perp DEX cohort (perps hub /perps) ───
  drift: "/logos/drift.png",
  vertex: "/logos/vertex.png",
  edgex: "/logos/edgex.jpg",
  extended: "/logos/extended.svg",
  aevo: "/logos/aevo.svg",
  pacifica: "/logos/pacifica.svg",
  variational: "/logos/variational.png",
  ostium: "/logos/ostium.png",
  grvt: "/logos/grvt.jpg",

  // ─── Prediction market categories (polymarket-resolution-delay) ───
  // Bench rows are category buckets, not products, so these stay
  // unregistered in PROVIDER_REGISTRY (no product page link).
  "all-markets": "/logos/all-markets.svg",
  sports: "/logos/sports.svg",
  crypto: "/logos/crypto.svg",
  politics: "/logos/politics.svg",
  other: "/logos/other.svg",
  bebop: "/logos/bebop.svg",
  kyberswap: "/logos/kyberswap.svg",
  paraswap: "/logos/paraswap.png",
  relay: "/logos/relay.svg",
  lifi: "/logos/lifi.png",
  geckoterminal: "/logos/geckoterminal.png",
  gains: "/logos/gains.svg",
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
  "near-intents": "/logos/near-intents.svg",
  wormhole: "/logos/wormhole.png",
  hyperlane: "/logos/hyperlane.webp",
  layerzero: "/logos/layerzero.webp",
  axelar: "/logos/axelar.webp",
  // Chainlink CCIP reuses the parent Chainlink brand mark.
  "chainlink-ccip": "/logos/chainlink.svg",

  // ─── Public RPC providers ───
  publicnode: "/logos/publicnode.avif",
  infura: "/logos/infura.png",
  ankr: "/logos/ankr.png",
  chainstack: "/logos/chainstack.svg",
  drpc: "/logos/drpc.webp",
  thirdweb: "/logos/thirdweb.png",
  gelato: "/logos/gelato.svg",
  "1rpc": "/logos/1rpc.svg",
  cloudflare: "/logos/cloudflare.svg",
  parity: "/logos/parity.png",
  polkadot: "/logos/polkadot.png",
  "base-official": "/logos/base.jpeg",
  binance: "/logos/binance.png",
  lava: "/logos/lava.webp",
  nodies: "/logos/nodies.png",
  tenderly: "/logos/tenderly.svg",
  tonapi: "/logos/tonapi.png",
  meowrpc: "/logos/meowrpc.jpg",

  // ─── MEV / private mempools (gas-estimation, RPC capabilities) ───
  flashbots: "/logos/flashbots.svg",
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

  // ─── HyperEVM RPC providers (bench 092) ───
  stakely: "/logos/stakely.svg",
  hypurrscan: "/logos/hypurrscan.webp",
  purroofgroup: "/logos/purroofgroup.png",

  // ─── Cosmos RPC providers (Osmosis + Cosmos Hub + Injective + Neutron benches) ───
  polkachu: "/logos/polkachu.svg",
  lavenderfive: "/logos/lavenderfive.svg",
  imperator: "/logos/imperator.svg",

  // ─── Batch 3 RPC cluster chains (benches 094-100) ───
  "cosmos-hub": "/logos/cosmos-hub.svg",
  "world-chain": "/logos/world-chain.png",
  kaia: "/logos/kaia.png",
  ink: "/logos/ink.svg",

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

  // ─── Long-tail RPC cluster chains (benches 055-066) ───
  gnosis: "/logos/gnosis.png",
  moonbeam: "/logos/moonbeam.png",
  unichain: "/logos/unichain.png",
  cronos: "/logos/cronos.png",
  fraxtal: "/logos/fraxtal.png",
  soneium: "/logos/soneium.png",

  // ─── Solana transaction landing services (bench 016) ───
  jito: "/logos/jito.svg",
  nozomi: "/logos/nozomi.svg",
  bloxroute: "/logos/bloxroute.png",
  "0slot": "/logos/0slot.png",
  nextblock: "/logos/nextblock.png",
  astralane: "/logos/astralane.svg",
  solanavibestation: "/logos/solanavibestation.png",
  leorpc: "/logos/leorpc.png",
  aapl: "/logos/aapl.svg",
  nvda: "/logos/nvda.svg",
  googl: "/logos/googl.svg",
  tsla: "/logos/tsla.svg",
  pltr: "/logos/pltr.svg",
  meta: "/logos/meta.svg",
  amd: "/logos/amd.svg",
  msft: "/logos/msft.svg",
  amzn: "/logos/amzn.png",
  spy: "/logos/spy.svg",
  mu: "/logos/mu.png",
  qqq: "/logos/qqq.png",
  "orca-solana": "/logos/orca.png",
  "pyth-market": "/logos/pyth.jpg",

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
  opensea: "/logos/opensea.svg",
  "pump-portal": "/logos/pump-portal.svg",
  quicknode: "/logos/quicknode.svg",
  "the-graph": "/logos/the-graph.svg",

  // ─── asset-registry-coverage + dex-network-coverage bench providers
  //     (bench № 005 split into 005a/005b) ───
  coinpaprika: "/logos/coinpaprika.svg",
  coinstats: "/logos/coinstats.svg",

  // ─── portfolio-chain-coverage bench providers (bench № 067) ───
  zerion: "/logos/zerion.svg",
  allium: "/logos/allium.png",
  goldrush: "/logos/covalent.svg",

  // ─── explorer-chain-coverage bench providers (bench № 068) ───
  routescan: "/logos/routescan.png",
  blockchair: "/logos/blockchair.png",
  subscan: "/logos/subscan.png",
  oklink: "/logos/oklink.png",

  // ─── Hyperliquid frontends (bench № 030) ───
  "phantom-perps": "/logos/phantom-perps.svg",
  axiom: "/logos/axiom.png",
  "pvp-trade": "/logos/pvp-trade.png",
  insilico: "/logos/insilico.svg",
  defiapp: "/logos/defiapp.svg",
  metamask: "/logos/metamask.svg",
  dexari: "/logos/dexari.png",
  okto: "/logos/okto.png",

  // ─── Perp funding venues (bench № 036) ───
  bybit: "/logos/bybit.jpg",
  okx: "/logos/okx.jpg",
  paradex: "/logos/paradex.jpg",
  aster: "/logos/aster.svg",

  // ─── Perp funding stability cohort additions (bench № 043) ───
  // Sourced via Mobula CEFI funding-rate aggregator.
  bitget: "/logos/bitget.png",
  coinbase: "/logos/coinbase.png",
  deribit: "/logos/deribit.png",
  gate: "/logos/gate.png",
  kraken: "/logos/kraken.png",
  kucoin: "/logos/kucoin.png",
  mexc: "/logos/mexc.png",

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
  slash: "/logos/slash.png",
  topdog: "/logos/topdog.jpg",
  "markets-mobile": "/logos/markets-mobile.svg",
  dextrabot: "/logos/dextrabot.png",
  kinto: "/logos/kinto.jpg",
  hypersignals: "/logos/hypersignals.png",
  ccxt: "/logos/ccxt.png",
  splash: "/logos/splash.png",
  vooi: "/logos/vooi.jpg",
  hyperx: "/logos/hyperx.png",
  miracle: "/logos/miracle.jpg",
  xbit: "/logos/xbit.png",
  "tuleep-trade": "/logos/tuleep-trade.png",
  "aura-money": "/logos/aura-money.jpg",
  "cro-trade": "/logos/cro-trade.png",
  owlyfi: "/logos/owlyfi.jpg",
  goodcryptox: "/logos/goodcryptox.jpg",
  "origami-tech": "/logos/origami-tech.jpg",
  cwallet: "/logos/cwallet.jpg",
  onchaincc: "/logos/onchaincc.png",
  "kucoin-web3": "/logos/kucoin-web3.jpg",
  vergex: "/logos/vergex.jpg",
  nansen: "/logos/nansen.jpg",
  gemwallet: "/logos/gemwallet.jpeg",
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
  vibeliquid: "/logos/vibeliquid.svg",
  superx: "/logos/superx.avif",
  supurr: "/logos/supurr.svg",
  unigox: "/logos/unigox.svg",
  uxuy: "/logos/uxuy.svg",
  wunder: "/logos/wunder.png",
  grider: "/logos/grider.jpg",
  tradoor: "/logos/tradoor.png",
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
  blinklabs: "/logos/blinklabs.svg",
  blocksec: "/logos/blocksec.jpg",
  "48club": "/logos/48club.png",
  pancakeswap: "/logos/pancakeswap.png",
  mevblocker: "/logos/mevblocker.svg",

  // ─── Ethereum block builders (bench № 085) ───
  // `other` (aggregate long-tail row) reuses /logos/other.svg above.
  titan: "/logos/titan.png",
  quasar: "/logos/quasar.png",
  eureka: "/logos/eureka.png",
  buildernet: "/logos/buildernet.png",
  beaverbuild: "/logos/beaverbuild.jpg",
  btcs: "/logos/btcs.png",
  bobthebuilder: "/logos/bobthebuilder.jpg",
  vanilla: "/logos/vanilla.svg",

  // ─── Oracles (bench № 082 oracle-freshness) ───
  pyth: "/logos/pyth.jpg",
  redstone: "/logos/redstone.png",

  // ─── Hyperliquid frontends registry expansion (60 → 66, 2026-06-28) ───
  // Identified via on-chain HL referral codes + brand cross-reference
  // (DFS, UNITYWALLET, INVO, MARSGO, BITGETWALLET). See builders.json
  // notes on the HL node for the provenance trail per address.
  "defi-saver": "/logos/defi-saver.jpg",
  unitywallet: "/logos/unitywallet.png",
  invo: "/logos/invo.png",
  marsgo: "/logos/marsgo.jpg",
  "bitget-wallet": "/logos/bitget-wallet.png",

  // ─── RWA yield tokens (bench 089 rwa-yield-accuracy) ───
  usdy: "/logos/usdy.svg",
  ousg: "/logos/ousg.svg",
  ustb: "/logos/ustb.svg",
  "syrup-usdc": "/logos/syrup-usdc.svg",
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
  hypercore: "hyperliquid", // HyperCore is the Hyperliquid trading engine, same brand
  "publicnode-feehistory": "publicnode",
  // Same brand split across two HL builder addresses; one logo is enough.
  "metamask-alt": "metamask",

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
  // Long-tail RPC cluster (055-066).
  "sonic-official": "sonic",
  "monad-official": "monad",
  "solana-official": "solana",
  "solana-labs": "solana",
  "polkadot-official": "parity",
  "osmosis-official": "osmosis",
  "hyperliquid-official": "hyperliquid",
  trongrid: "tron",
  "injective-official": "injective",
  "worldchain-official": "world-chain",
  "kaia-official": "kaia",
  "ink-official": "gelato",
  "ink-quicknode": "quicknode",
  "opbnb-official": "opbnb",
  hood: "robinhood",
  coin: "coinbase",
  "megaeth-official": "megaeth",
  "celo-official": "celo",
  "blast-official": "blast",
  "taiko-official": "taiko",
  "berachain-official": "berachain",
  "zksync-official": "zksync",
  "gnosis-official": "gnosis",
  "moonbeam-official": "moonbeam",
  "unichain-official": "unichain",
  "cronos-official": "cronos",
  "fraxtal-official": "fraxtal",
  "soneium-official": "soneium",

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
