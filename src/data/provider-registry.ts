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
    url: "https://dydx.exchange",
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
};

export function getProviderRegistry(slug: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY[slug.toLowerCase()];
}
