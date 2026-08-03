package main

import (
	"os"
	"strings"
)

// Provider is one public RPC endpoint we probe. The Slug is the
// stable identifier surfaced in Prometheus labels (matches the
// OpenChainBench spec YAML); the URL can be overridden via env var
// like RPC_URL_ETHEREUM_PUBLICNODE without a rebuild so we can swap
// endpoints if one goes flaky.
//
// Slug convention. Universal providers (publicnode, drpc, 1rpc,
// meowrpc, tenderly, nodies, lava, merkle) share the same slug
// across every chain they support. Chain-specific providers
// (foundation RPCs, brand-specific endpoints) carry a distinct slug
// (base-official, binance, optimism-official, arbitrum-official,
// avalanche-official, flashbots, cloudflare) so the leaderboard
// doesn't try to compare them against themselves on chains they
// don't claim to cover.
type Provider struct {
	Slug string
	Name string
	URL  string
}

type Chain struct {
	Slug      string
	Name      string
	Providers []Provider
	// Kind selects the probe path:
	//   "" or "evm": eth_getBlockByNumber("latest", false), block-based
	//     staleness, archive-depth loop.
	//   "solana": getSlot at processed commitment, slot-based staleness,
	//     no archive-depth loop.
	//   "polkadot": chain_getHeader against Substrate JSON-RPC,
	//     block-based staleness (Polkadot relay produces one block every
	//     ~6 s so staleBlockGap needs a Polkadot-specific override, see
	//     polkadotStaleBlockGap), no archive-depth loop (Polkadot's
	//     state model does not map onto the eth_getBalance-by-depth
	//     probe cleanly).
	//   "cosmos": Tendermint / CometBFT `status` method against the
	//     Cosmos JSON-RPC, block-based staleness (Osmosis ~6 s blocks,
	//     see cosmosStaleBlockGap), no archive-depth loop. Cosmos chains
	//     access historical state via ABCI queries keyed on module +
	//     KV-store, which does not map onto the flat eth_getBalance
	//     probe. Consensus quorum is opt-out for now because
	//     latest_block_hash on Tendermint changes on every block just
	//     like EVM, but a first pass ships without it to keep the
	//     initial Osmosis add-on isolated to latency + reliability.
	Kind string
}

// chains is the source of truth for the (chain × provider) probe
// matrix. Every (chain, provider) entry was live-verified no-key on
// the OCB matrix-expansion sweep (agents A/B/C/D/E) before being
// added here — anything that needed an API key, returned 403 nginx,
// or rate-limited too aggressively for 15 s polling was excluded.
//
// Excluded by audit. Ankr (key-gated), LlamaRPC + BlockPI + OmniaTech
// (Cloudflare 521 / region-blocked), Alchemy demo (rate-limited
// dead), NodeReal / GetBlock / Chainstack (key-gated), gateway.fm
// (Ethereum-only with 29 req/IP budget, too tight for 15 s cadence),
// Merkle on Ethereum (1 req then 20-min Cloudflare lockout — keep
// Merkle only for Base + BSC where it's stable), Lava on chains
// other than Ethereum + Arbitrum (subdomains exist but return 403
// without a key; exception: sonic.lava.build is open no-key).
//
// Long-tail sweep 2026-07-03 (12 chains added, every endpoint
// re-verified live: eth_chainId match + 4 consecutive probes).
// Excluded by that sweep: MeowRPC on all long-tail chains (DNS gone,
// provider appears defunct outside its legacy chains), Sei EVM
// (drpc caches eth_blockNumber → only 2 clean providers), opBNB
// (1rpc 429s at probe cadence, only 3 solid providers), Mode
// (3 providers), Zora / Abstract / HyperEVM (≤2 keyless providers).
//
// Local-run filter: OCB_CHAINS=ethereum,base restricts the matrix to
// the listed slugs (unset or unmatched = full matrix). Used for local
// smoke runs; never set in production.
func chains() []Chain {
	all := []Chain{
		// ─── Polkadot relay chain — first non-EVM, non-Solana chain
		// added to the cohort. Substrate JSON-RPC via chain_getHeader
		// (returns hex block number, staleness by relay-block gap).
		// Providers verified keyless with 4 consecutive probes on
		// 2026-07-15: rpc.polkadot.io (Parity official), OnFinality
		// public gateway, and PublicNode (Allnodes). Excluded by that
		// sweep: 1RPC (chain_getHeader filtered as "Not Allowed" on
		// their privacy relay), Dwellir (503 Service Unavailable
		// during audit, retry when their gateway stabilises), Ankr
		// (paid Polkadot tier only), Chainstack (key-gated),
		// RadiumBlock (empty response without referral header), Grove/
		// Thirdweb (invalid-chain or key-gated).
		{
			Slug: "polkadot",
			Name: "Polkadot",
			Kind: "polkadot",
			Providers: []Provider{
				{Slug: "polkadot-official", Name: "Parity", URL: envDefault("RPC_URL_POLKADOT_OFFICIAL", "https://rpc.polkadot.io")},
				{Slug: "onfinality", Name: "OnFinality", URL: envDefault("RPC_URL_POLKADOT_ONFINALITY", "https://polkadot.api.onfinality.io/public")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_POLKADOT_PUBLICNODE", "https://polkadot-rpc.publicnode.com")},
			},
		},
		// ─── Osmosis (Cosmos SDK, CometBFT / Tendermint) — first
		// Cosmos chain in the cluster. Probed via Tendermint JSON-RPC
		// `status` (returns sync_info.latest_block_height +
		// latest_block_hash). Providers verified keyless with a live
		// `status` POST returning a parsable decimal height on
		// 2026-07-23. Excluded by that sweep: Lava
		// (osmosis.tendermintrpc.lava.build 403 without a key despite
		// the "public" branding), OnFinality (public osmosis endpoint
		// timing out at probe cadence, unlike their stable Polkadot
		// gateway), Numia (401 without key), AutoStake (404, path may
		// have moved), BlockApsis + WhisperNode + Enigma-Validator +
		// StakeTown + reece.sh (curl-side connect errors, likely IPv6-
		// only or geo-gated). Ankr and Chainstack require paid Cosmos
		// tiers.
		{
			Slug: "osmosis",
			Name: "Osmosis",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "osmosis-official", Name: "Osmosis Foundation", URL: envDefault("RPC_URL_OSMOSIS_OFFICIAL", "https://rpc.osmosis.zone")},
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_OSMOSIS_POLKACHU", "https://osmosis-rpc.polkachu.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_OSMOSIS_PUBLICNODE", "https://osmosis-rpc.publicnode.com")},
				{Slug: "imperator", Name: "Imperator", URL: envDefault("RPC_URL_OSMOSIS_IMPERATOR", "https://rpc-osmosis.imperator.co")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_OSMOSIS_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/osmosis")},
			},
		},
		// ─── Cosmos Hub (bench 094) — added 2026-07-24. Original Cosmos
		// SDK chain, ATOM staking. Same Tendermint status probe as Osmosis.
		// Providers live-verified keyless: publicnode, polkachu,
		// lavenderfive, lava (`cosmoshub.tendermintrpc.lava.build`).
		// Excluded: rpc.cosmos.network (Cloudflare 525), OnFinality +
		// BlockApsis + AllThatNode (DNS-fail or moved).
		{
			Slug: "cosmos-hub",
			Name: "Cosmos Hub",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_COSMOSHUB_PUBLICNODE", "https://cosmos-rpc.publicnode.com")},
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_COSMOSHUB_POLKACHU", "https://cosmos-rpc.polkachu.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_COSMOSHUB_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/cosmoshub")},
				{Slug: "lava", Name: "Lava Network", URL: envDefault("RPC_URL_COSMOSHUB_LAVA", "https://cosmoshub.tendermintrpc.lava.build")},
			},
		},
		// ─── Injective (bench 095) — added 2026-07-24. Cosmos SDK L1
		// tuned for orderbook DEXs. Providers live-verified keyless:
		// injective-official (tm.injective.network), publicnode, polkachu,
		// lavenderfive. Excluded: sentry.tm.injective.network (dupe of
		// official), AllThatNode (DNS-fail).
		{
			Slug: "injective",
			Name: "Injective",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "injective-official", Name: "Injective Foundation", URL: envDefault("RPC_URL_INJECTIVE_OFFICIAL", "https://tm.injective.network")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_INJECTIVE_PUBLICNODE", "https://injective-rpc.publicnode.com")},
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_INJECTIVE_POLKACHU", "https://injective-rpc.polkachu.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_INJECTIVE_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/injective")},
			},
		},
		// ─── Neutron (bench 096) — added 2026-07-24. Cosmos SDK smart-
		// contract chain secured by Cosmos Hub validators via Interchain
		// Security. Providers live-verified keyless: publicnode, polkachu,
		// lavenderfive. Excluded: rpc-kralum.neutron-1.neutron.org
		// (SSL handshake failure), P2P.org + WhisperNode (DNS-fail).
		{
			Slug: "neutron",
			Name: "Neutron",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_NEUTRON_PUBLICNODE", "https://neutron-rpc.publicnode.com")},
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_NEUTRON_POLKACHU", "https://neutron-rpc.polkachu.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_NEUTRON_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/neutron")},
			},
		},
		// ─── Solana mainnet — added 2026-07-12, all 5 endpoints keyless
		// and live-verified (getSlot + getLatestBlockhash + getVersion,
		// mutually consistent advancing slots). Excluded by that sweep:
		// dRPC (Solana paid-only), Ankr (403 key required), OnFinality
		// (shared public quota permanently 429), BlockPI (503 no public
		// URL), Blast API + ExtrNode + AllThatNode (DNS dead), Triton
		// free.rpcpool.com (403), OMNIA (521), Helius/Shyft/BlockEden
		// (key-gated). LeoRPC uses a publicly documented FREE query key,
		// disclosed in the bench methodology.
		{
			Slug: "solana",
			Name: "Solana",
			Kind: "solana",
			Providers: []Provider{
				{Slug: "solana", Name: "Solana", URL: envDefault("RPC_URL_SOLANA_OFFICIAL", "https://api.mainnet-beta.solana.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_SOLANA_PUBLICNODE", "https://solana-rpc.publicnode.com")},
				{Slug: "lava", Name: "Lava", URL: envDefault("RPC_URL_SOLANA_LAVA", "https://solana.lava.build")},
				{Slug: "leorpc", Name: "LeoRPC", URL: envDefault("RPC_URL_SOLANA_LEORPC", "https://solana.leorpc.com/?api_key=FREE")},
				{Slug: "solanavibestation", Name: "Solana Vibe Station", URL: envDefault("RPC_URL_SOLANA_SVS", "https://public.rpc.solanavibestation.com")},
			},
		},
		// ─── Monad mainnet (chain 143) — added 2026-07-08, all endpoints
		// live-verified (eth_chainId=143 + anti-cache probe). Five official
		// mirrors exist behind different infra vendors; we probe the primary
		// rpc.monad.xyz as the chain-official plus the multi-chain gateways.
		{
			Slug: "monad",
			Name: "Monad",
			Providers: []Provider{
				{Slug: "monad-official", Name: "Monad Official", URL: envDefault("RPC_URL_MONAD_OFFICIAL", "https://rpc.monad.xyz")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_MONAD_DRPC", "https://monad-mainnet.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_MONAD_TENDERLY", "https://monad.gateway.tenderly.co")},
				{Slug: "bloxroute", Name: "bloXroute", URL: envDefault("RPC_URL_MONAD_BLOXROUTE", "https://monad.rpc.blxrbdn.com")},
				{Slug: "onfinality", Name: "OnFinality", URL: envDefault("RPC_URL_MONAD_ONFINALITY", "https://monad-mainnet.api.onfinality.io/public")},
			},
		},
		// ─── MegaETH mainnet (chain 4326) — added 2026-07-08, all endpoints
		// live-verified. Official endpoint uses dynamic compute-unit limiting;
		// 1 probe/30s/region stays far under it.
		{
			Slug: "megaeth",
			Name: "MegaETH",
			Providers: []Provider{
				{Slug: "megaeth-official", Name: "MegaETH Official", URL: envDefault("RPC_URL_MEGAETH_OFFICIAL", "https://mainnet.megaeth.com/rpc")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_MEGAETH_DRPC", "https://megaeth.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_MEGAETH_TENDERLY", "https://megaeth.gateway.tenderly.co")},
			},
		},
		// ─── Ethereum mainnet (9 providers) ────────────────────────
		{
			Slug: "ethereum",
			Name: "Ethereum",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_ETHEREUM_PUBLICNODE", "https://ethereum-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ETHEREUM_DRPC", "https://eth.drpc.org")},
				{Slug: "meowrpc", Name: "MeowRPC", URL: envDefault("RPC_URL_ETHEREUM_MEOWRPC", "https://eth.meowrpc.com")},
				{Slug: "flashbots", Name: "Flashbots Protect", URL: envDefault("RPC_URL_ETHEREUM_FLASHBOTS", "https://rpc.flashbots.net")},
				{Slug: "cloudflare", Name: "Cloudflare", URL: envDefault("RPC_URL_ETHEREUM_CLOUDFLARE", "https://cloudflare-eth.com")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_ETHEREUM_TENDERLY", "https://gateway.tenderly.co/public/mainnet")},
				{Slug: "nodies", Name: "Nodies (POKT)", URL: envDefault("RPC_URL_ETHEREUM_NODIES", "https://eth-pokt.nodies.app")},
				{Slug: "lava", Name: "Lava Network", URL: envDefault("RPC_URL_ETHEREUM_LAVA", "https://eth1.lava.build")},
				{Slug: "blastapi", Name: "Blast API", URL: envDefault("RPC_URL_ETHEREUM_BLASTAPI", "https://eth-mainnet.public.blastapi.io")},
				{Slug: "gatewayfm", Name: "Gateway.fm", URL: envDefault("RPC_URL_ETHEREUM_GATEWAYFM", "https://rpc.eth.gateway.fm")},
				{Slug: "bloxroute", Name: "bloXroute", URL: envDefault("RPC_URL_ETHEREUM_BLOXROUTE", "https://eth.rpc.blxrbdn.com")},
			},
		},
		// ─── Polygon PoS (5 providers) ──────────────────────────────
		{
			Slug: "polygon",
			Name: "Polygon",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_POLYGON_PUBLICNODE", "https://polygon-bor-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_POLYGON_DRPC", "https://polygon.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_POLYGON_TENDERLY", "https://gateway.tenderly.co/public/polygon")},
				{Slug: "nodies", Name: "Nodies (POKT)", URL: envDefault("RPC_URL_POLYGON_NODIES", "https://polygon-pokt.nodies.app")},
			},
		},
		// ─── Arbitrum One (8 providers) ─────────────────────────────
		{
			Slug: "arbitrum",
			Name: "Arbitrum One",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_ARBITRUM_PUBLICNODE", "https://arbitrum-one-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ARBITRUM_DRPC", "https://arbitrum.drpc.org")},
				{Slug: "meowrpc", Name: "MeowRPC", URL: envDefault("RPC_URL_ARBITRUM_MEOWRPC", "https://arbitrum.meowrpc.com")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_ARBITRUM_TENDERLY", "https://gateway.tenderly.co/public/arbitrum")},
				{Slug: "nodies", Name: "Nodies (POKT)", URL: envDefault("RPC_URL_ARBITRUM_NODIES", "https://arb-pokt.nodies.app")},
				{Slug: "lava", Name: "Lava Network", URL: envDefault("RPC_URL_ARBITRUM_LAVA", "https://arb1.lava.build")},
				{Slug: "arbitrum-official", Name: "Arbitrum Official", URL: envDefault("RPC_URL_ARBITRUM_OFFICIAL", "https://arb1.arbitrum.io/rpc")},
				{Slug: "blastapi", Name: "Blast API", URL: envDefault("RPC_URL_ARBITRUM_BLASTAPI", "https://arbitrum-one.public.blastapi.io")},
			},
		},
		// ─── Optimism (6 providers) ─────────────────────────────────
		{
			Slug: "optimism",
			Name: "Optimism",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_OPTIMISM_PUBLICNODE", "https://optimism-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_OPTIMISM_DRPC", "https://optimism.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_OPTIMISM_TENDERLY", "https://gateway.tenderly.co/public/optimism")},
				{Slug: "nodies", Name: "Nodies (POKT)", URL: envDefault("RPC_URL_OPTIMISM_NODIES", "https://op-pokt.nodies.app")},
				{Slug: "optimism-official", Name: "Optimism Official", URL: envDefault("RPC_URL_OPTIMISM_OFFICIAL", "https://mainnet.optimism.io")},
			},
		},
		// ─── Base (6 providers) ─────────────────────────────────────
		{
			Slug: "base",
			Name: "Base",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_BASE_PUBLICNODE", "https://base-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_BASE_DRPC", "https://base.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_BASE_TENDERLY", "https://gateway.tenderly.co/public/base")},
				{Slug: "nodies", Name: "Nodies (POKT)", URL: envDefault("RPC_URL_BASE_NODIES", "https://base-pokt.nodies.app")},
				{Slug: "base-official", Name: "Base Official", URL: envDefault("RPC_URL_BASE_OFFICIAL", "https://mainnet.base.org")},
				{Slug: "blastapi", Name: "Blast API", URL: envDefault("RPC_URL_BASE_BLASTAPI", "https://base-mainnet.public.blastapi.io")},
				{Slug: "bloxroute", Name: "bloXroute", URL: envDefault("RPC_URL_BASE_BLOXROUTE", "https://base.rpc.blxrbdn.com")},
			},
		},
		// ─── BNB Chain (5 providers) ────────────────────────────────
		{
			Slug: "bnb",
			Name: "BNB Chain",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_BNB_PUBLICNODE", "https://bsc-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_BNB_DRPC", "https://bsc.drpc.org")},
				{Slug: "nodies", Name: "Nodies (POKT)", URL: envDefault("RPC_URL_BNB_NODIES", "https://bsc-pokt.nodies.app")},
				{Slug: "binance", Name: "Binance Official", URL: envDefault("RPC_URL_BNB_OFFICIAL", "https://bsc-dataseed1.binance.org")},
				{Slug: "blastapi", Name: "Blast API", URL: envDefault("RPC_URL_BNB_BLASTAPI", "https://bsc-mainnet.public.blastapi.io")},
				{Slug: "bloxroute", Name: "bloXroute", URL: envDefault("RPC_URL_BNB_BLOXROUTE", "https://bsc.rpc.blxrbdn.com")},
			},
		},
		// ─── Avalanche C-Chain (6 providers) ────────────────────────
		// Note: Nodies and Avalanche-Official both require the
		// /ext/bc/C/rpc path suffix; the rest are at the root.
		{
			Slug: "avalanche",
			Name: "Avalanche C-Chain",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_AVALANCHE_PUBLICNODE", "https://avalanche-c-chain-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_AVALANCHE_DRPC", "https://avalanche.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_AVALANCHE_TENDERLY", "https://gateway.tenderly.co/public/avalanche")},
				{Slug: "avalanche-official", Name: "Avalanche Official", URL: envDefault("RPC_URL_AVALANCHE_OFFICIAL", "https://api.avax.network/ext/bc/C/rpc")},
			},
		},
		// ─── Linea (4 providers) ────────────────────────────────────
		{
			Slug: "linea",
			Name: "Linea",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_LINEA_PUBLICNODE", "https://linea-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_LINEA_DRPC", "https://linea.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_LINEA_TENDERLY", "https://gateway.tenderly.co/public/linea")},
			},
		},
		// ─── Scroll (4 providers) ───────────────────────────────────
		// Note: Tenderly uses slug `scroll-mainnet` (not `scroll`) on this chain.
		{
			Slug: "scroll",
			Name: "Scroll",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_SCROLL_PUBLICNODE", "https://scroll-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_SCROLL_DRPC", "https://scroll.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_SCROLL_TENDERLY", "https://gateway.tenderly.co/public/scroll-mainnet")},
			},
		},
		// ─── Mantle (4 providers) ───────────────────────────────────
		{
			Slug: "mantle",
			Name: "Mantle",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_MANTLE_PUBLICNODE", "https://mantle-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_MANTLE_DRPC", "https://mantle.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_MANTLE_TENDERLY", "https://gateway.tenderly.co/public/mantle")},
			},
		},
		// ─── Sonic (6 providers) ────────────────────────────────────
		{
			Slug: "sonic",
			Name: "Sonic",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_SONIC_PUBLICNODE", "https://sonic-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_SONIC_DRPC", "https://sonic.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_SONIC_TENDERLY", "https://gateway.tenderly.co/public/sonic")},
				{Slug: "lava", Name: "Lava Network", URL: envDefault("RPC_URL_SONIC_LAVA", "https://sonic.lava.build")},
				{Slug: "sonic-official", Name: "Sonic Labs Official", URL: envDefault("RPC_URL_SONIC_OFFICIAL", "https://rpc.soniclabs.com")},
			},
		},
		// ─── Gnosis (6 providers) ───────────────────────────────────
		{
			Slug: "gnosis",
			Name: "Gnosis",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_GNOSIS_PUBLICNODE", "https://gnosis-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_GNOSIS_DRPC", "https://gnosis.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_GNOSIS_TENDERLY", "https://gateway.tenderly.co/public/gnosis")},
				{Slug: "gnosis-official", Name: "Gnosis Official", URL: envDefault("RPC_URL_GNOSIS_OFFICIAL", "https://rpc.gnosischain.com")},
			},
		},
		// ─── Celo (5 providers) ─────────────────────────────────────
		{
			Slug: "celo",
			Name: "Celo",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_CELO_PUBLICNODE", "https://celo-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_CELO_DRPC", "https://celo.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_CELO_TENDERLY", "https://gateway.tenderly.co/public/celo")},
				{Slug: "celo-official", Name: "Celo Official (Forno)", URL: envDefault("RPC_URL_CELO_OFFICIAL", "https://forno.celo.org")},
			},
		},
		// ─── Blast (4 providers) ────────────────────────────────────
		{
			Slug: "blast",
			Name: "Blast",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_BLAST_PUBLICNODE", "https://blast-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_BLAST_DRPC", "https://blast.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_BLAST_TENDERLY", "https://gateway.tenderly.co/public/blast")},
				{Slug: "blast-official", Name: "Blast Official", URL: envDefault("RPC_URL_BLAST_OFFICIAL", "https://rpc.blast.io")},
			},
		},
		// ─── Taiko (4 providers) ────────────────────────────────────
		// Note: Tenderly uses slug `taiko-mainnet` (plain `taiko` 404s).
		{
			Slug: "taiko",
			Name: "Taiko",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_TAIKO_PUBLICNODE", "https://taiko-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_TAIKO_DRPC", "https://taiko.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_TAIKO_TENDERLY", "https://gateway.tenderly.co/public/taiko-mainnet")},
				{Slug: "taiko-official", Name: "Taiko Official", URL: envDefault("RPC_URL_TAIKO_OFFICIAL", "https://rpc.taiko.xyz")},
			},
		},
		// ─── Moonbeam (5 providers) ─────────────────────────────────
		// Note: 1RPC uses the token code `glmr` (`/moonbeam` 400s).
		{
			Slug: "moonbeam",
			Name: "Moonbeam",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_MOONBEAM_PUBLICNODE", "https://moonbeam-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_MOONBEAM_DRPC", "https://moonbeam.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_MOONBEAM_TENDERLY", "https://gateway.tenderly.co/public/moonbeam")},
				{Slug: "moonbeam-official", Name: "Moonbeam Official", URL: envDefault("RPC_URL_MOONBEAM_OFFICIAL", "https://rpc.api.moonbeam.network")},
			},
		},
		// ─── Berachain (4 providers) ────────────────────────────────
		{
			Slug: "berachain",
			Name: "Berachain",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_BERACHAIN_PUBLICNODE", "https://berachain-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_BERACHAIN_DRPC", "https://berachain.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_BERACHAIN_TENDERLY", "https://gateway.tenderly.co/public/berachain")},
				{Slug: "berachain-official", Name: "Berachain Official", URL: envDefault("RPC_URL_BERACHAIN_OFFICIAL", "https://rpc.berachain.com")},
			},
		},
		// ─── zkSync Era (4 providers) ───────────────────────────────
		// Note: PublicNode does not serve zkSync (both subdomain
		// guesses 404) — verified 2026-07-03.
		{
			Slug: "zksync",
			Name: "zkSync Era",
			Providers: []Provider{
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ZKSYNC_DRPC", "https://zksync.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_ZKSYNC_TENDERLY", "https://gateway.tenderly.co/public/zksync")},
				{Slug: "zksync-official", Name: "zkSync Official", URL: envDefault("RPC_URL_ZKSYNC_OFFICIAL", "https://mainnet.era.zksync.io")},
			},
		},
		// ─── Cronos (4 providers) ───────────────────────────────────
		// Note: PublicNode subdomain is `cronos-evm-rpc` (`cronos-rpc`
		// resolves but returns non-JSON).
		{
			Slug: "cronos",
			Name: "Cronos",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_CRONOS_PUBLICNODE", "https://cronos-evm-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_CRONOS_DRPC", "https://cronos.drpc.org")},
				{Slug: "cronos-official", Name: "Cronos Official", URL: envDefault("RPC_URL_CRONOS_OFFICIAL", "https://evm.cronos.org")},
			},
		},
		// ─── Fraxtal (4 providers) ──────────────────────────────────
		{
			Slug: "fraxtal",
			Name: "Fraxtal",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_FRAXTAL_PUBLICNODE", "https://fraxtal-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_FRAXTAL_DRPC", "https://fraxtal.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_FRAXTAL_TENDERLY", "https://gateway.tenderly.co/public/fraxtal")},
				{Slug: "fraxtal-official", Name: "Fraxtal Official", URL: envDefault("RPC_URL_FRAXTAL_OFFICIAL", "https://rpc.frax.com")},
			},
		},
		// ─── Unichain (5 providers) ─────────────────────────────────
		{
			Slug: "unichain",
			Name: "Unichain",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_UNICHAIN_PUBLICNODE", "https://unichain-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_UNICHAIN_DRPC", "https://unichain.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_UNICHAIN_TENDERLY", "https://gateway.tenderly.co/public/unichain")},
				{Slug: "unichain-official", Name: "Unichain Official", URL: envDefault("RPC_URL_UNICHAIN_OFFICIAL", "https://mainnet.unichain.org")},
			},
		},
		// ─── Soneium (4 providers) ──────────────────────────────────
		{
			Slug: "soneium",
			Name: "Soneium",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_SONEIUM_PUBLICNODE", "https://soneium-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_SONEIUM_DRPC", "https://soneium.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_SONEIUM_TENDERLY", "https://gateway.tenderly.co/public/soneium")},
				{Slug: "soneium-official", Name: "Soneium Official", URL: envDefault("RPC_URL_SONEIUM_OFFICIAL", "https://rpc.soneium.org")},
			},
		},
		// ─── Hyperliquid HyperEVM (chain 999) — added 2026-07-24. Standard
		// EVM JSON-RPC surface bolted onto the HyperCore perps engine.
		// Providers live-verified keyless via eth_blockNumber during launch
		// audit: hyperliquid-official (rpc.hyperliquid.xyz/evm), dRPC,
		// Stakely, Purroof Group, Hypurrscan. Excluded by that sweep:
		// Alchemy demo (rate-limited dead), thirdweb (`Invalid chain`
		// error on HyperEVM), Grove/Pocket public LB (needs app id at
		// public LB path), AllThatNode + Blast API + Chainstack + Gelato
		// + Imperator HyperEVM guesses (DNS-fail or 401 without key),
		// PublicNode (no HyperEVM subdomain yet).
		{
			Slug: "hyperliquid",
			Name: "Hyperliquid",
			Providers: []Provider{
				{Slug: "hyperliquid-official", Name: "Hyperliquid Labs", URL: envDefault("RPC_URL_HYPERLIQUID_OFFICIAL", "https://rpc.hyperliquid.xyz/evm")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_HYPERLIQUID_DRPC", "https://hyperliquid.drpc.org")},
				{Slug: "stakely", Name: "Stakely", URL: envDefault("RPC_URL_HYPERLIQUID_STAKELY", "https://hyperliquid-json-rpc.stakely.io")},
				{Slug: "purroofgroup", Name: "Purroof Group", URL: envDefault("RPC_URL_HYPERLIQUID_PURROOF", "https://rpc.purroofgroup.com")},
				{Slug: "hypurrscan", Name: "Hypurrscan", URL: envDefault("RPC_URL_HYPERLIQUID_HYPURRSCAN", "https://rpc.hypurrscan.io")},
			},
		},
		// ─── TRON (JSON-RPC compat surface only) — added 2026-07-24.
		// TRON exposes both a native REST API (wallet/getnowblock) and
		// an EVM-compatible JSON-RPC surface at /jsonrpc. We probe the
		// JSON-RPC surface because that is the path every cross-chain
		// wallet + TronWeb/EVM bridge integrates against. Providers
		// live-verified keyless via eth_blockNumber during launch
		// audit: TronGrid (api.trongrid.io/jsonrpc — Tron Foundation
		// official), dRPC and PublicNode/Allnodes. Excluded by that
		// sweep: Ankr (API key required despite public branding),
		// Chainstack + NOWNodes + GetBlock + Tatum + BlockPI (all
		// require API key on TRON JSON-RPC path), OnFinality + Blast
		// API + AllThatNode (no public TRON JSON-RPC gateway). The
		// TRON JSON-RPC provider market is materially smaller than
		// EVM — most TRON infra vendors expose only the native TRON
		// REST API keyless. Native REST API surface is out of scope
		// for this cluster; a `tron-rest` bench would need a
		// chain-specific probe.
		{
			Slug: "tron",
			Name: "TRON",
			Providers: []Provider{
				{Slug: "trongrid", Name: "TronGrid", URL: envDefault("RPC_URL_TRON_TRONGRID", "https://api.trongrid.io/jsonrpc")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_TRON_DRPC", "https://tron.drpc.org")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_TRON_PUBLICNODE", "https://tron.publicnode.com/jsonrpc")},
			},
		},
		// ─── World Chain (bench 097) — added 2026-07-24. OP Stack rollup
		// (chain 480) operated by Tools for Humanity, ETH gas, blob
		// calldata settlement on Ethereum. Providers live-verified
		// keyless: worldchain-official (Alchemy public path), drpc,
		// tenderly, thirdweb. Excluded: PublicNode (no worldchain
		// subdomain yet), Stakelab + Grove (DNS-fail).
		{
			Slug: "world-chain",
			Name: "World Chain",
			Providers: []Provider{
				{Slug: "worldchain-official", Name: "World Chain", URL: envDefault("RPC_URL_WORLDCHAIN_OFFICIAL", "https://worldchain-mainnet.g.alchemy.com/public")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_WORLDCHAIN_DRPC", "https://worldchain.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_WORLDCHAIN_TENDERLY", "https://worldchain-mainnet.gateway.tenderly.co")},
			},
		},
		// ─── Kaia (bench 098) — added 2026-07-24. EVM L1 formed by
		// Klaytn + Finschia merger. Providers live-verified keyless:
		// kaia-official (public-en.node.kaia.io), drpc, thirdweb.
		// Excluded: BlockPI (`Apikey not found`), Nodies (paid tier),
		// Alchemy public (KAIA_MAINNET not enabled), AllThatNode +
		// OnFinality + Chainstack + Tatum + NowNodes (DNS-fail or key
		// required).
		{
			Slug: "kaia",
			Name: "Kaia",
			Providers: []Provider{
				{Slug: "kaia-official", Name: "Kaia Foundation", URL: envDefault("RPC_URL_KAIA_OFFICIAL", "https://public-en.node.kaia.io")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_KAIA_DRPC", "https://klaytn.drpc.org")},
			},
		},
		// ─── Ink (bench 099) — added 2026-07-24. OP Stack rollup
		// (chain 57073) launched by Kraken. Two official active-active
		// endpoints: Gelato-backed rpc-gel + QuickNode-backed rpc-qnd.
		// Providers live-verified keyless: ink-official (Gelato),
		// ink-quicknode (QuickNode), drpc, tenderly, thirdweb.
		// Excluded: Alchemy public (chain not enabled on public tier),
		// Blast API (no longer available).
		{
			Slug: "ink",
			Name: "Ink",
			Providers: []Provider{
				{Slug: "ink-official", Name: "Gelato", URL: envDefault("RPC_URL_INK_OFFICIAL", "https://rpc-gel.inkonchain.com")},
				{Slug: "ink-quicknode", Name: "QuickNode", URL: envDefault("RPC_URL_INK_QUICKNODE", "https://rpc-qnd.inkonchain.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_INK_DRPC", "https://ink.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_INK_TENDERLY", "https://ink.gateway.tenderly.co")},
			},
		},
		// ─── opBNB (bench 100) — added 2026-07-24. OP Stack rollup
		// (chain 204) operated by the BNB Chain team, settlement onto
		// BNB Chain (not Ethereum). Providers live-verified keyless:
		// opbnb-official (bnbchain.org), publicnode, drpc, thirdweb.
		// Excluded: NodeReal (API key required), BlockPI (`unknown host`),
		// Grove (needs app id), Tatum (404).
		{
			Slug: "opbnb",
			Name: "opBNB",
			Providers: []Provider{
				{Slug: "opbnb-official", Name: "BNB Chain Team", URL: envDefault("RPC_URL_OPBNB_OFFICIAL", "https://opbnb-mainnet-rpc.bnbchain.org")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_OPBNB_PUBLICNODE", "https://opbnb-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_OPBNB_DRPC", "https://opbnb.drpc.org")},
			},
		},
		// ─── Sei EVM (bench 108) — added 2026-07-26. Cosmos SDK L1 with
		// EVM parallel-execution layer (chain 1329). Native EVM JSON-RPC.
		// The 2026-07-03 sweep excluded Sei because drpc cached
		// eth_blockNumber leaving only 2 clean providers; re-audit on
		// 2026-07-26 confirms dRPC no longer caches, and Thirdweb +
		// Stakeme.pro have come online, restoring 4 clean keyless
		// providers. Providers live-verified: sei-official
		// (evm-rpc.sei-apis.com), drpc, thirdweb, stakeme. Excluded:
		// PublicNode (no sei-evm subdomain), Tenderly public (no
		// sei route), BlockPI (Apikey required), MeowRPC (defunct),
		// Basement Nodes / Node75 / AllThatNode (host unresolvable
		// or key-gated). Sei's dual Cosmos + EVM stack means this bench
		// scopes strictly to the EVM side; the Cosmos JSON-RPC would
		// need a Kind:"cosmos" entry as we did for Osmosis.
		{
			Slug: "sei",
			Name: "Sei EVM",
			Providers: []Provider{
				{Slug: "sei-official", Name: "Sei Labs", URL: envDefault("RPC_URL_SEI_OFFICIAL", "https://evm-rpc.sei-apis.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_SEI_DRPC", "https://sei.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_SEI_THIRDWEB", "https://sei.rpc.thirdweb.com")},
				{Slug: "stakeme", Name: "Stakeme", URL: envDefault("RPC_URL_SEI_STAKEME", "https://sei-evm-rpc.stakeme.pro")},
			},
		},
		// ─── Mode (bench 109) — added 2026-07-26. OP Stack L2 (chain
		// 34443), Base-ecosystem-adjacent, DeFi + AI positioning. The
		// 2026-07-03 sweep excluded Mode with 3 providers; re-audit on
		// 2026-07-26 adds Thirdweb (now live on Mode) to bring the count
		// to 4 clean keyless providers. Providers live-verified:
		// mode-official (mainnet.mode.network), drpc, 1rpc, thirdweb.
		// Excluded: Tenderly public (no mode route), Blast API
		// (discontinued), MeowRPC + PublicNode (no mode subdomain).
		{
			Slug: "mode",
			Name: "Mode",
			Providers: []Provider{
				{Slug: "mode-official", Name: "Mode Labs", URL: envDefault("RPC_URL_MODE_OFFICIAL", "https://mainnet.mode.network")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_MODE_DRPC", "https://mode.drpc.org")},
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_MODE_1RPC", "https://1rpc.io/mode")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_MODE_THIRDWEB", "https://mode.rpc.thirdweb.com")},
			},
		},
		// ─── Ronin (bench 110) — added 2026-07-26. EVM gaming L1
		// (chain 2020) operated by Sky Mavis, primary home of Axie
		// Infinity + Pixels + a broader gaming ecosystem. 4 clean
		// keyless providers live-verified: ronin-official
		// (api.roninchain.com), drpc, tenderly, thirdweb. Excluded:
		// Ronin Tech secondary (DNS-fail), PublicNode (no ronin
		// subdomain), lgns.net (DNS-fail).
		{
			Slug: "ronin",
			Name: "Ronin",
			Providers: []Provider{
				{Slug: "ronin-official", Name: "Sky Mavis", URL: envDefault("RPC_URL_RONIN_OFFICIAL", "https://api.roninchain.com/rpc")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_RONIN_DRPC", "https://ronin.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_RONIN_TENDERLY", "https://ronin.gateway.tenderly.co")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_RONIN_THIRDWEB", "https://ronin.rpc.thirdweb.com")},
			},
		},
		// ─── Immutable zkEVM (bench 111) — added 2026-07-26. Polygon
		// CDK-based zkEVM L2 (chain 13371) operated by Immutable,
		// dedicated Web3 gaming stack. 4 clean keyless providers
		// live-verified: immutable-official (rpc.immutable.com), drpc,
		// tenderly, thirdweb. Excluded: PublicNode (no subdomain),
		// Alchemy public (chain not enabled), Tenderly's rpc.
		// -prefixed alias (route redirects to keyed path).
		{
			Slug: "immutable",
			Name: "Immutable zkEVM",
			Providers: []Provider{
				{Slug: "immutable-official", Name: "Immutable", URL: envDefault("RPC_URL_IMMUTABLE_OFFICIAL", "https://rpc.immutable.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_IMMUTABLE_DRPC", "https://immutable-zkevm.drpc.org")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_IMMUTABLE_TENDERLY", "https://immutable.gateway.tenderly.co")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_IMMUTABLE_THIRDWEB", "https://immutable-zkevm.rpc.thirdweb.com")},
			},
		},
		// ─── Kava EVM (bench 121) — added 2026-08-02. Cosmos SDK L1
		// (chain 2222) with native EVM execution, ~5 s block time.
		// The 2026-07-03 long-tail sweep excluded Kava for not meeting
		// the 3-provider threshold; re-audit on 2026-08-02 confirms
		// Thirdweb now supports Kava EVM, restoring 3 clean keyless
		// providers. Live-verified: kava-official (evm.kava.io), drpc
		// (kava.drpc.org), thirdweb (kava.rpc.thirdweb.com). Excluded:
		// PublicNode (method-not-found on eth_getBlockByNumber), Tenderly
		// (no kava route), Blast API (no listing), OnFinality (429 on
		// public quota without key), 1RPC (unknown network).
		{
			Slug: "kava",
			Name: "Kava",
			Providers: []Provider{
				{Slug: "kava-official", Name: "Kava Labs", URL: envDefault("RPC_URL_KAVA_OFFICIAL", "https://evm.kava.io")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_KAVA_DRPC", "https://kava.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_KAVA_THIRDWEB", "https://kava.rpc.thirdweb.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_KAVA_PUBLICNODE", "https://kava-evm-rpc.publicnode.com")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_KAVA_ANKR", "https://rpc.ankr.com/kava_evm")},
			},
		},
		// ─── Zora (bench 122) — added 2026-08-02. OP Stack rollup
		// (chain 7777777) by Zora Network, ~2 s sequencer cadence, ETH
		// gas, NFT-focused ecosystem. The 2026-07-03 long-tail sweep
		// excluded Zora for having ≤2 keyless providers; re-audit on
		// 2026-08-02 confirms Thirdweb now supports Zora, restoring
		// 3 clean keyless providers. Live-verified: zora-official
		// (rpc.zora.energy), drpc (zora.drpc.org), thirdweb
		// (zora.rpc.thirdweb.com). Excluded: Tenderly (no zora route),
		// Alchemy public (ZORA_MAINNET not enabled on public tier),
		// Blast API (discontinued).
		{
			Slug: "zora",
			Name: "Zora",
			Providers: []Provider{
				{Slug: "zora-official", Name: "Zora Network", URL: envDefault("RPC_URL_ZORA_OFFICIAL", "https://rpc.zora.energy")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ZORA_DRPC", "https://zora.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_ZORA_THIRDWEB", "https://zora.rpc.thirdweb.com")},
			},
		},
		// 2026-08-02 audit. Abstract ZK Stack (chain 2741). 3 clean keyless
		// providers. Live-verified: abstract-official (api.mainnet.abs.xyz),
		// drpc (abstract.drpc.org), thirdweb (abstract.rpc.thirdweb.com).
		// Excluded: Ankr (no abstract route), Alchemy (key required),
		// Infura (key required), QuickNode (key required).
		{
			Slug: "abstract",
			Name: "Abstract",
			Providers: []Provider{
				{Slug: "abstract-official", Name: "Abstract Foundation", URL: envDefault("RPC_URL_ABSTRACT_OFFICIAL", "https://api.mainnet.abs.xyz")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ABSTRACT_DRPC", "https://abstract.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_ABSTRACT_THIRDWEB", "https://abstract.rpc.thirdweb.com")},
			},
		},
		// 2026-08-02 audit. ApeChain Arbitrum Orbit L3 (chain 33139). 3 clean
		// keyless providers. Live-verified: apechain-official
		// (rpc.apechain.com/http), drpc (apechain.drpc.org), thirdweb
		// (apechain.rpc.thirdweb.com). Excluded: Alchemy (key required),
		// QuickNode (key required), Infura (no apechain route).
		{
			Slug: "apechain",
			Name: "ApeChain",
			Providers: []Provider{
				{Slug: "apechain-official", Name: "ApeChain", URL: envDefault("RPC_URL_APECHAIN_OFFICIAL", "https://rpc.apechain.com/http")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_APECHAIN_DRPC", "https://apechain.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_APECHAIN_THIRDWEB", "https://apechain.rpc.thirdweb.com")},
			},
		},
		// 2026-08-02 audit. Lisk OP Stack L2 (chain 1135). 3 clean keyless
		// providers. Live-verified: lisk-official (rpc.api.lisk.com),
		// drpc (lisk.drpc.org), thirdweb (lisk.rpc.thirdweb.com). Excluded:
		// Blast API (no lisk route), Alchemy (key required), Infura (no lisk
		// route), QuickNode (key required).
		{
			Slug: "lisk",
			Name: "Lisk",
			Providers: []Provider{
				{Slug: "lisk-official", Name: "Lisk", URL: envDefault("RPC_URL_LISK_OFFICIAL", "https://rpc.api.lisk.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_LISK_DRPC", "https://lisk.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_LISK_THIRDWEB", "https://lisk.rpc.thirdweb.com")},
			},
		},
		// 2026-08-02 audit. Swellchain OP Stack L2 (chain 1923). 3 clean
		// keyless providers. Live-verified: ankr (rpc.ankr.com/swell), sentio
		// (swell-mainnet.rpc.sentio.xyz), thirdweb (1923.rpc.thirdweb.com).
		// Excluded: official alt.technology endpoint (401 without key),
		// drpc (no swell route), Alchemy (key required).
		{
			Slug: "swellchain",
			Name: "Swellchain",
			Providers: []Provider{
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_SWELLCHAIN_ANKR", "https://rpc.ankr.com/swell")},
				{Slug: "sentio", Name: "Sentio", URL: envDefault("RPC_URL_SWELLCHAIN_SENTIO", "https://swell-mainnet.rpc.sentio.xyz")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_SWELLCHAIN_THIRDWEB", "https://1923.rpc.thirdweb.com")},
			},
		},
		// 2026-08-02 audit. Cyber Network OP Stack L2 (chain 7560). 3 clean
		// keyless providers. Live-verified: cyber-official (rpc.cyber.co),
		// altlayer (cyber.alt.technology), thirdweb (7560.rpc.thirdweb.com).
		// Excluded: drpc (no cyber route), Blast API (no listing),
		// Alchemy (key required).
		{
			Slug: "cyber",
			Name: "Cyber",
			Providers: []Provider{
				{Slug: "cyber-official", Name: "Cyber Network", URL: envDefault("RPC_URL_CYBER_OFFICIAL", "https://rpc.cyber.co")},
				{Slug: "altlayer", Name: "AltLayer", URL: envDefault("RPC_URL_CYBER_ALTLAYER", "https://cyber.alt.technology")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_CYBER_THIRDWEB", "https://7560.rpc.thirdweb.com")},
			},
		},
	}

	filter := strings.TrimSpace(os.Getenv("OCB_CHAINS"))
	if filter == "" {
		return all
	}
	keep := make(map[string]bool)
	for _, s := range strings.Split(filter, ",") {
		keep[strings.TrimSpace(s)] = true
	}
	var out []Chain
	for _, c := range all {
		if keep[c.Slug] {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return all
	}
	return out
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
