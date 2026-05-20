/**
 * Provider registry. Optional enrichment for each provider slug that
 * appears in one or more benchmark specs.
 *
 * The registry is purely additive. Providers without an entry still
 * render at /providers/<slug>, they just lack the description, URL,
 * and Twitter handle. Add a new entry when onboarding a provider.
 *
 * Keep descriptions sober and technical. One or two short sentences,
 * factual, no marketing adjectives. Twitter handle without the URL.
 */

export type ProviderRegistryEntry = {
  url: string;
  description: string;
  twitter?: string;
};

export const PROVIDER_REGISTRY: Record<string, ProviderRegistryEntry> = {
  // ─── Data aggregator APIs ─────────────────────────────────────
  mobula: {
    url: "https://mobula.io",
    description:
      "Onchain data aggregator covering 80+ chains. WebSocket fast-trade feed, REST market and metadata, wallet portfolio APIs.",
    twitter: "@MobulaFi",
  },
  codex: {
    url: "https://www.codex.io",
    description:
      "Onchain market data API for EVM and Solana. GraphQL and WebSocket feeds for tokens, pairs, trades, and pricing.",
    twitter: "@CodexData",
  },
  geckoterminal: {
    url: "https://www.geckoterminal.com",
    description:
      "DEX data terminal by CoinGecko covering 200+ chains. REST API for pools, tokens, trades, and OHLCV.",
    twitter: "@GeckoTerminal",
  },
  jupiter: {
    url: "https://jup.ag",
    description:
      "Solana swap aggregator. REST APIs for quotes, swap routing, price, and token lists across Solana DEXs.",
    twitter: "@JupiterExchange",
  },
  moralis: {
    url: "https://moralis.io",
    description:
      "Multi-chain Web3 data API across EVM chains and Solana. REST endpoints for tokens, NFTs, wallets, balances, and prices.",
    twitter: "@MoralisWeb3",
  },
  helius: {
    url: "https://www.helius.dev",
    description:
      "Solana RPC and data provider. Enhanced transactions, webhooks, DAS API for assets, and standard JSON-RPC.",
    twitter: "@heliuslabs",
  },

  // ─── Bridges ──────────────────────────────────────────────────
  relay: {
    url: "https://relay.link",
    description:
      "Cross-chain intent network from Reservoir. Users sign an intent, relayers compete to fill on the destination, settlement is typically sub-30 seconds.",
    twitter: "@RelayProtocol",
  },
  lifi: {
    url: "https://li.fi",
    description:
      "Cross-chain bridge and DEX aggregator. Routes swaps across bridges and liquidity sources via a single API, with EVM and Solana support.",
    twitter: "@lifiprotocol",
  },
  debridge: {
    url: "https://debridge.finance",
    description:
      "Cross-chain intent protocol using the DLN solver network. Liquidity is filled by solvers on the destination chain, no wrapped assets or LP pools.",
    twitter: "@deBridgeFinance",
  },

  // ─── Perp DEX ─────────────────────────────────────────────────
  lighter: {
    url: "https://lighter.xyz",
    description:
      "Onchain perp DEX with a fully onchain orderbook on a zkSync rollup. ZK proofs verify matching, no off-chain sequencer for trade execution.",
    twitter: "@Lighter_xyz",
  },
  hyperliquid: {
    url: "https://hyperliquid.xyz",
    description:
      "Onchain perp DEX on the Hyperliquid L1. Fully onchain orderbook with sub-second matching, no off-chain matching engine.",
    twitter: "@HyperliquidX",
  },
  dydx: {
    url: "https://dydx.trade",
    description:
      "Perp DEX on the dYdX Chain, a Cosmos SDK appchain. Orderbook with off-chain matching and onchain settlement, validators propagate orders via the mempool.",
    twitter: "@dYdX",
  },
  gmx: {
    url: "https://gmx.io",
    description:
      "Perp DEX on Arbitrum and Avalanche. Pool-based execution against GLP and GM vaults, oracle-priced trades with no orderbook.",
    twitter: "@GMX_IO",
  },
  gains: {
    url: "https://gains.trade",
    description:
      "Perp DEX on Polygon, Arbitrum, Base and Solana. Pool-based execution against the gToken vaults, oracle-priced trades with synthetic leverage.",
    twitter: "@GainsNetwork_io",
  },

  // ─── Wallet labels / explorers ────────────────────────────────
  blockscout: {
    url: "https://www.blockscout.com",
    description:
      "Open-source multi-chain EVM block explorer. Exposes address tags and public labels through its REST and JSON-RPC APIs.",
    twitter: "@blockscoutcom",
  },
  oli: {
    url: "https://www.openlabelsinitiative.org",
    description:
      "Open Labels Initiative, a community standard and shared dataset for EVM address labels. Distributes labels via GitHub and a public API.",
    twitter: "@open_labels",
  },
  tonapi: {
    url: "https://tonapi.io",
    description:
      "REST API for the TON blockchain. Returns account metadata, known entity names, and address book labels for TON wallets.",
    twitter: "@tonapi_io",
  },
  stellarexpert: {
    url: "https://stellar.expert",
    description:
      "Block explorer for the Stellar network. Provides a directory API of curated account labels, anchors, and known issuers.",
    twitter: "@stellarexpert",
  },
  xrpscan: {
    url: "https://xrpscan.com",
    description:
      "Block explorer for the XRP Ledger. Offers a public REST API with account info and known wallet names via its names endpoint.",
    twitter: "@xrpscan",
  },
  walletexplorer: {
    url: "https://www.walletexplorer.com",
    description:
      "Bitcoin address clusterer and labeler. Tracks exchange deposit clusters, mixers, and known services since 2013.",
  },

  // ─── L1 chains ────────────────────────────────────────────────
  bnb: {
    url: "https://www.bnbchain.org",
    description:
      "Proof-of-Staked-Authority L1 with 21 active validators rotating per epoch. Probabilistic finality reached after roughly 2 blocks. Block time around 3 seconds.",
    twitter: "@BNBCHAIN",
  },
  avalanche: {
    url: "https://www.avax.network",
    description:
      "Primary Network runs the Snowman BFT consensus derived from Snow protocols. Sub-second deterministic finality with no chain reorganizations.",
    twitter: "@avax",
  },
  sui: {
    url: "https://sui.io",
    description:
      "Move-based L1 using Mysticeti BFT consensus over a DAG. Owned-object transactions bypass consensus via Fast Path. Deterministic finality under one second.",
    twitter: "@SuiNetwork",
  },
  ton: {
    url: "https://ton.org",
    description:
      "BFT Proof-of-Stake L1 with a sharded masterchain and workchain architecture. Deterministic finality within a few seconds. Block time near 5 seconds.",
    twitter: "@ton_blockchain",
  },
  stellar: {
    url: "https://stellar.org",
    description:
      "Federated Byzantine Agreement via the Stellar Consensus Protocol with quorum slices. Deterministic finality per ledger close, roughly every 5 seconds.",
    twitter: "@StellarOrg",
  },
  solana: {
    url: "https://solana.com",
    description:
      "Proof-of-History sequencing combined with Tower BFT consensus. Probabilistic finality at 32 confirmed slots. Slot time around 400 milliseconds.",
    twitter: "@solana",
  },
  tron: {
    url: "https://tron.network",
    description:
      "DPoS L1 with 27 elected Super Representatives. 3-second block times and deterministic finality after about 19 confirmations.",
    twitter: "@trondao",
  },
  ethereum: {
    url: "https://ethereum.org",
    description:
      "PoS chain using Gasper (Casper FFG plus LMD-GHOST). 12-second slots with deterministic finality every two epochs, roughly 12.8 minutes.",
    twitter: "@ethereum",
  },
  cardano: {
    url: "https://cardano.org",
    description:
      "Ouroboros Praos PoS with 20-second slots and 1 block per 20 seconds on average. Probabilistic finality after about 2,160 blocks (k parameter).",
    twitter: "@Cardano",
  },
  litecoin: {
    url: "https://litecoin.org",
    description:
      "PoW chain with 2.5-minute block times and Scrypt mining. UTXO model inherited from Bitcoin with subsidy halvings every 840,000 blocks.",
    twitter: "@litecoin",
  },
  monero: {
    url: "https://www.getmonero.org",
    description:
      "Privacy-focused PoW chain using RandomX, tuned for CPU mining. 2-minute block times with ring signatures of size 16 and stealth addresses by default.",
    twitter: "@monero",
  },

  // ─── Public RPC providers ─────────────────────────────────────
  publicnode: {
    url: "https://www.publicnode.com",
    description:
      "Public no-key RPC service operated by Allnodes covering 70+ chains. JSON-RPC and WebSocket endpoints with archive support on most networks.",
    twitter: "@AllnodesHQ",
  },
  drpc: {
    url: "https://drpc.org",
    description:
      "Decentralized RPC mesh routing requests across third-party node providers with consensus checks. Free public tier plus higher-tier authenticated access.",
    twitter: "@drpcorg",
  },
  "1rpc": {
    url: "https://1rpc.io",
    description:
      "Privacy-preserving public RPC by Automata Network. Strips client metadata before forwarding to upstream node operators; load-balanced across providers.",
    twitter: "@1RPC_io",
  },
  meowrpc: {
    url: "https://meowrpc.com",
    description:
      "Free public RPC service covering Ethereum, Base, Arbitrum, Optimism and other EVM chains. No registration required, modest rate limits per IP.",
  },
  flashbots: {
    url: "https://rpc.flashbots.net",
    description:
      "Flashbots Protect RPC sends transactions through a private mempool, shielding them from sandwich attacks. Read calls go to a standard Ethereum node behind the proxy.",
    twitter: "@flashbots",
  },
  cloudflare: {
    url: "https://cloudflare-eth.com",
    description:
      "Cloudflare's public Ethereum gateway. Recently switched to a permissioned mode for many JSON-RPC methods, returning `-32046 Cannot fulfill request` for most endpoints.",
    twitter: "@Cloudflare",
  },
  "base-official": {
    url: "https://mainnet.base.org",
    description:
      "Official Base public RPC operated by the Base team (Coinbase). No-key access for read methods; documented as best-effort with rate limits.",
    twitter: "@base",
  },
  binance: {
    url: "https://docs.bnbchain.org/docs/rpc",
    description:
      "Official BNB Chain RPC endpoints operated by Binance. Multiple dataseed hosts (`bsc-dataseed1.binance.org` etc.) round-robin for load distribution.",
    twitter: "@BNBCHAIN",
  },

  // ─── Gas oracles ──────────────────────────────────────────────
  blocknative: {
    url: "https://www.blocknative.com",
    description:
      "Mempool observability platform with a probability-of-inclusion gas oracle. EIP-1559 tier predictions exposed via the public /gasprices/blockprices endpoint, free tier without an API key.",
    twitter: "@blocknative",
  },
  "publicnode-feehistory": {
    url: "https://www.publicnode.com",
    description:
      "Gas predictor that wraps the canonical eth_feeHistory JSON-RPC method against PublicNode's Ethereum endpoint. Returns reward percentiles directly from the EIP-1559 spec implementation; no proprietary model.",
    twitter: "@AllnodesHQ",
  },
  owlracle: {
    url: "https://owlracle.info",
    description:
      "Multi-oracle gas aggregator across Ethereum, BNB Chain, Polygon and other EVM chains. Free tier 100 requests/hour, 1000/h with a free API key. Recommendation aggregates several upstream oracles into a single tier value.",
    twitter: "@owlracle",
  },
  etherscan: {
    url: "https://etherscan.io/gastracker",
    description:
      "Most-visited Ethereum gas tracker on the web, operated by Etherscan. The v2 gastracker API exposes Safe / Propose / Fast tiers; the legacy single-price shape predates EIP-1559's per-tier priority-fee model.",
    twitter: "@etherscan",
  },

  // ─── Stablecoin issuers (appearing as providers in peg bench) ─
  usdc: {
    url: "https://www.circle.com/usdc",
    description:
      "Circle's USD-redeemed stablecoin, audited and backed by short-duration Treasuries and same-day USD cash. Same-day primary-market redemption with US banks is the structural anchor for the peg.",
    twitter: "@circle",
  },
  usdt: {
    url: "https://tether.to",
    description:
      "Tether's USD-pegged stablecoin, the dominant pair currency on most non-US crypto venues. Primary-market redemption is slower than USDC; secondary-market peg carries a premium during risk-on minutes.",
    twitter: "@Tether_to",
  },
  dai: {
    url: "https://makerdao.com",
    description:
      "MakerDAO's overcollateralized stablecoin (now Sky's USDS legacy version). CEX coverage is essentially dead in 2026; the only honest live peg signal is on-chain via Curve 3pool's get_dy.",
    twitter: "@MakerDAO",
  },
  fdusd: {
    url: "https://firstdigitallabs.com",
    description:
      "First Digital USD, Hong Kong-issued stablecoin backed 1:1 by USD reserves. Primary depth lives on Binance USDT-quoted FDUSDUSDT; USD-quoted venues offer negligible volume.",
    twitter: "@firstdigitallabs",
  },
  usde: {
    url: "https://ethena.fi",
    description:
      "Ethena's synthetic dollar anchored by a delta-neutral basis trade on perpetual futures. Flashed to $0.65 on Binance USDEUSDT during the October 10 2025 liquidation cascade.",
    twitter: "@ethena_labs",
  },
};

export function getProviderRegistry(slug: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY[slug.toLowerCase()];
}
