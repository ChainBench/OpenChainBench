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
		// ─── Ethereum mainnet (8 providers) ────────────────────────
		{
			Slug: "ethereum",
			Name: "Ethereum",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_ETHEREUM_PUBLICNODE", "https://ethereum-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ETHEREUM_DRPC", "https://eth.drpc.org")},
				{Slug: "meowrpc", Name: "MeowRPC", URL: envDefault("RPC_URL_ETHEREUM_MEOWRPC", "https://eth.meowrpc.com")},
				{Slug: "flashbots", Name: "Flashbots Protect", URL: envDefault("RPC_URL_ETHEREUM_FLASHBOTS", "https://rpc.flashbots.net")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_ETHEREUM_TENDERLY", "https://gateway.tenderly.co/public/mainnet")},
				{Slug: "nodies", Name: "Nodies (POKT)", URL: envDefault("RPC_URL_ETHEREUM_NODIES", "https://eth-pokt.nodies.app")},
				{Slug: "lava", Name: "Lava Network", URL: envDefault("RPC_URL_ETHEREUM_LAVA", "https://eth1.lava.build")},
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
		// official), PublicNode/Allnodes. Excluded: dRPC (method not
		// available on TRON JSON-RPC path), Ankr (API key required
		// despite public branding), Chainstack + NOWNodes + GetBlock +
		// Tatum + BlockPI (all require API key on TRON JSON-RPC path),
		// OnFinality + Blast API + AllThatNode (no public TRON JSON-RPC
		// gateway). The TRON JSON-RPC provider market is materially
		// smaller than EVM — most TRON infra vendors expose only the
		// native TRON REST API keyless. Native REST API surface is out
		// of scope for this cluster; a `tron-rest` bench would need a
		// chain-specific probe.
		{
			Slug: "tron",
			Name: "TRON",
			Providers: []Provider{
				{Slug: "trongrid", Name: "TronGrid", URL: envDefault("RPC_URL_TRON_TRONGRID", "https://api.trongrid.io/jsonrpc")},
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
		// kaia-official (public-en.node.kaia.io). Excluded: dRPC (500
		// paid plan only), BlockPI (`Apikey not found`), Nodies (paid
		// tier), Alchemy public (KAIA_MAINNET not enabled), AllThatNode +
		// OnFinality + Chainstack + Tatum + NowNodes (DNS-fail or key
		// required).
		{
			Slug: "kaia",
			Name: "Kaia",
			Providers: []Provider{
				{Slug: "kaia-official", Name: "Kaia Foundation", URL: envDefault("RPC_URL_KAIA_OFFICIAL", "https://public-en.node.kaia.io")},
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
		// Providers live-verified: sei-official (evm-rpc.sei-apis.com),
		// thirdweb, stakeme. Excluded: dRPC (500 persistent internal error
		// after 3 consecutive attempts), PublicNode (no sei-evm subdomain),
		// Tenderly public (no sei route), BlockPI (Apikey required),
		// MeowRPC (defunct), Basement Nodes / Node75 / AllThatNode
		// (host unresolvable or key-gated). Sei's dual Cosmos + EVM stack
		// means this bench scopes strictly to the EVM side.
		{
			Slug: "sei",
			Name: "Sei EVM",
			Providers: []Provider{
				{Slug: "sei-official", Name: "Sei Labs", URL: envDefault("RPC_URL_SEI_OFFICIAL", "https://evm-rpc.sei-apis.com")},
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
		// Infinity + Pixels + a broader gaming ecosystem. 3 clean
		// keyless providers live-verified: ronin-official
		// (api.roninchain.com), tenderly, thirdweb. Excluded:
		// dRPC (500 persistent internal error after 3 attempts),
		// Ronin Tech secondary (DNS-fail), PublicNode (no ronin
		// subdomain), lgns.net (DNS-fail).
		{
			Slug: "ronin",
			Name: "Ronin",
			Providers: []Provider{
				{Slug: "ronin-official", Name: "Sky Mavis", URL: envDefault("RPC_URL_RONIN_OFFICIAL", "https://api.roninchain.com/rpc")},
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
				{Slug: "conduit", Name: "Conduit", URL: envDefault("RPC_URL_ZORA_CONDUIT", "https://rpc-zora-mainnet-0.t.conduit.xyz")},
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
				{Slug: "tenderly", Name: "Tenderly", URL: envDefault("RPC_URL_APECHAIN_TENDERLY", "https://gateway.tenderly.co/public/apechain")},
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
				{Slug: "tenderly", Name: "Tenderly", URL: envDefault("RPC_URL_LISK_TENDERLY", "https://gateway.tenderly.co/public/lisk")},
			},
		},
		// 2026-08-03: added drpc (swell.drpc.org). 4 total.
		// 2026-08-02 audit. Swellchain OP Stack L2 (chain 1923). 3 clean
		// keyless providers. Live-verified: ankr (rpc.ankr.com/swell), sentio
		// (swell-mainnet.rpc.sentio.xyz), thirdweb (1923.rpc.thirdweb.com).
		// Excluded: official alt.technology endpoint (401 without key),
		// Alchemy (key required).
		{
			Slug: "swellchain",
			Name: "Swellchain",
			Providers: []Provider{
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_SWELLCHAIN_ANKR", "https://rpc.ankr.com/swell")},
				{Slug: "sentio", Name: "Sentio", URL: envDefault("RPC_URL_SWELLCHAIN_SENTIO", "https://swell-mainnet.rpc.sentio.xyz")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_SWELLCHAIN_THIRDWEB", "https://1923.rpc.thirdweb.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_SWELLCHAIN_DRPC", "https://swell.drpc.org")},
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
		// 2026-08-03 audit. Rootstock EVM sidechain (chain 30). 3 clean keyless
		// providers: rootstock-official (public-node.rsk.co), drpc
		// (rootstock.drpc.org), thirdweb (30.rpc.thirdweb.com).
		// Excluded: Blast API (shut down), Alchemy (key required).
		{
			Slug: "rootstock",
			Name: "Rootstock",
			Providers: []Provider{
				{Slug: "rootstock-official", Name: "Rootstock Foundation", URL: envDefault("RPC_URL_ROOTSTOCK_OFFICIAL", "https://public-node.rsk.co")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ROOTSTOCK_DRPC", "https://rootstock.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_ROOTSTOCK_THIRDWEB", "https://30.rpc.thirdweb.com")},
			},
		},
		// 2026-08-03 audit. Metis Andromeda optimistic rollup (chain 1088). 4 clean
		// keyless providers: metis-official (andromeda.metis.io), drpc
		// (metis.drpc.org), publicnode (metis-rpc.publicnode.com), thirdweb
		// (1088.rpc.thirdweb.com). Excluded: Ankr (key required for metis).
		{
			Slug: "metis",
			Name: "Metis",
			Providers: []Provider{
				{Slug: "metis-official", Name: "Metis", URL: envDefault("RPC_URL_METIS_OFFICIAL", "https://andromeda.metis.io/?owner=1088")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_METIS_DRPC", "https://metis.drpc.org")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_METIS_PUBLICNODE", "https://metis-rpc.publicnode.com")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_METIS_THIRDWEB", "https://1088.rpc.thirdweb.com")},
			},
		},
		// 2026-08-04 audit. Manta Pacific OP Stack L2 on Celestia DA (chain 169).
		// 4 clean keyless providers: manta-official (pacific-rpc.manta.network/http),
		// drpc (manta-pacific.drpc.org), thirdweb (169.rpc.thirdweb.com),
		// 1rpc (1rpc.io/manta). Excluded: Ankr (no manta pacific route), Alchemy (key required).
		{
			Slug: "manta",
			Name: "Manta Pacific",
			Providers: []Provider{
				{Slug: "manta-official", Name: "Manta Network", URL: envDefault("RPC_URL_MANTA_OFFICIAL", "https://pacific-rpc.manta.network/http")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_MANTA_DRPC", "https://manta-pacific.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_MANTA_THIRDWEB", "https://169.rpc.thirdweb.com")},
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_MANTA_1RPC", "https://1rpc.io/manta")},
			},
		},
		// 2026-08-04 audit. Story Protocol IP L1 (chain 1514). 4 clean keyless
		// providers: story-official (mainnet.storyrpc.io), ankr
		// (rpc.ankr.com/story_mainnet), stakely (story-json-rpc.stakely.io),
		// publicnode (story-rpc.publicnode.com). Excluded: Alchemy (key required), Infura (no story route).
		{
			Slug: "story",
			Name: "Story",
			Providers: []Provider{
				{Slug: "story-official", Name: "Story Foundation", URL: envDefault("RPC_URL_STORY_OFFICIAL", "https://mainnet.storyrpc.io")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_STORY_ANKR", "https://rpc.ankr.com/story_mainnet")},
				{Slug: "stakely", Name: "Stakely", URL: envDefault("RPC_URL_STORY_STAKELY", "https://story-json-rpc.stakely.io")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_STORY_PUBLICNODE", "https://story-rpc.publicnode.com")},
			},
		},
		// 2026-08-04 audit. Morph ZK Rollup L2 (chain 2818). 4 clean keyless
		// providers: morph-official (rpc.morphl2.io), drpc (morph.drpc.org),
		// thirdweb (2818.rpc.thirdweb.com), morph-quicknode (rpc-quicknode.morph.network).
		// Excluded: Ankr (no morph route), Alchemy (key required).
		{
			Slug: "morph",
			Name: "Morph",
			Providers: []Provider{
				{Slug: "morph-official", Name: "Morph", URL: envDefault("RPC_URL_MORPH_OFFICIAL", "https://rpc.morphl2.io")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_MORPH_DRPC", "https://morph.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_MORPH_THIRDWEB", "https://2818.rpc.thirdweb.com")},
				{Slug: "morph-quicknode", Name: "QuickNode", URL: envDefault("RPC_URL_MORPH_QUICKNODE", "https://rpc-quicknode.morph.network")},
			},
		},
		// 2026-08-03 audit. Moonriver Kusama parachain (chain 1285). 3 clean
		// keyless providers: moonriver-official (rpc.api.moonriver.moonbeam.network),
		// publicnode (moonriver-rpc.publicnode.com), onfinality
		// (moonriver.api.onfinality.io/public). Excluded: UnitedBloc
		// (moonriver.unitedbloc.com DNS dead), Ankr (key required for
		// moonriver), drpc (no moonriver route).
		{
			Slug: "moonriver",
			Name: "Moonriver",
			Providers: []Provider{
				{Slug: "moonriver-official", Name: "Moonbeam Foundation", URL: envDefault("RPC_URL_MOONRIVER_OFFICIAL", "https://rpc.api.moonriver.moonbeam.network")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_MOONRIVER_PUBLICNODE", "https://moonriver-rpc.publicnode.com")},
				{Slug: "onfinality", Name: "OnFinality", URL: envDefault("RPC_URL_MOONRIVER_ONFINALITY", "https://moonriver.api.onfinality.io/public")},
			},
		},
		// 2026-08-03 audit. Hemi BTC+ETH hybrid OP Stack L2 (chain 43111). 3 clean
		// keyless providers: hemi-official (rpc.hemi.network/rpc), drpc
		// (hemi.drpc.org), thirdweb (43111.rpc.thirdweb.com).
		// Excluded: Ankr (no hemi route), Alchemy (key required).
		{
			Slug: "hemi",
			Name: "Hemi",
			Providers: []Provider{
				{Slug: "hemi-official", Name: "Hemi Labs", URL: envDefault("RPC_URL_HEMI_OFFICIAL", "https://rpc.hemi.network/rpc")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_HEMI_DRPC", "https://hemi.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_HEMI_THIRDWEB", "https://43111.rpc.thirdweb.com")},
			},
		},
		// 2026-08-03 audit. BOB BTC+ETH hybrid OP Stack L2 (chain 60808). 4 clean
		// keyless providers: bob-official (rpc.gobob.xyz), tenderly
		// (bob.gateway.tenderly.co), drpc (bob.drpc.org), thirdweb
		// (60808.rpc.thirdweb.com). Excluded: Ankr (no bob route).
		{
			Slug: "bob",
			Name: "BOB",
			Providers: []Provider{
				{Slug: "bob-official", Name: "BOB", URL: envDefault("RPC_URL_BOB_OFFICIAL", "https://rpc.gobob.xyz")},
				{Slug: "tenderly", Name: "Tenderly", URL: envDefault("RPC_URL_BOB_TENDERLY", "https://bob.gateway.tenderly.co")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_BOB_DRPC", "https://bob.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_BOB_THIRDWEB", "https://60808.rpc.thirdweb.com")},
			},
		},
		// 2026-08-04 audit. Polygon zkEVM ZK rollup L2 (chain 1101). 3 clean keyless
		// providers: polygon-zkevm-official (zkevm-rpc.com), drpc (polygon-zkevm.drpc.org),
		// thirdweb (1101.rpc.thirdweb.com). Excluded: Ankr (no route), Alchemy (key required).
		{
			Slug: "polygon-zkevm",
			Name: "Polygon zkEVM",
			Providers: []Provider{
				{Slug: "polygon-zkevm-official", Name: "Polygon", URL: envDefault("RPC_URL_POLYGON_ZKEVM_OFFICIAL", "https://zkevm-rpc.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_POLYGON_ZKEVM_DRPC", "https://polygon-zkevm.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_POLYGON_ZKEVM_THIRDWEB", "https://1101.rpc.thirdweb.com")},
			},
		},
		// 2026-08-04 audit. Arbitrum Nova AnyTrust chain (chain 42170). 3 clean keyless
		// providers: publicnode (arbitrum-nova-rpc.publicnode.com), drpc (arbitrum-nova.drpc.org),
		// thirdweb (42170.rpc.thirdweb.com). Excluded: Ankr (no route), Alchemy (key required).
		{
			Slug: "arbitrum-nova",
			Name: "Arbitrum Nova",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_ARBITRUM_NOVA_PUBLICNODE", "https://arbitrum-nova-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ARBITRUM_NOVA_DRPC", "https://arbitrum-nova.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_ARBITRUM_NOVA_THIRDWEB", "https://42170.rpc.thirdweb.com")},
			},
		},
		// 2026-08-04 audit. X Layer OKX zkEVM L2 (chain 196). 3 clean keyless
		// providers: xlayer-official (rpc.xlayer.tech), drpc (xlayer.drpc.org),
		// thirdweb (196.rpc.thirdweb.com). Excluded: Ankr (no route), Alchemy (key required).
		{
			Slug: "xlayer",
			Name: "X Layer",
			Providers: []Provider{
				{Slug: "xlayer-official", Name: "X Layer", URL: envDefault("RPC_URL_XLAYER_OFFICIAL", "https://rpc.xlayer.tech")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_XLAYER_DRPC", "https://xlayer.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_XLAYER_THIRDWEB", "https://196.rpc.thirdweb.com")},
			},
		},
		// 2026-08-04 audit. Flare cross-chain data L1 (chain 14). 4 clean keyless
		// providers: flare-official (flare-api.flare.network/ext/bc/C/rpc), drpc (flare.drpc.org),
		// thirdweb (14.rpc.thirdweb.com), ankr (rpc.ankr.com/flare).
		// Excluded: Alchemy (no route), QuickNode (key required).
		{
			Slug: "flare",
			Name: "Flare",
			Providers: []Provider{
				{Slug: "flare-official", Name: "Flare Foundation", URL: envDefault("RPC_URL_FLARE_OFFICIAL", "https://flare-api.flare.network/ext/bc/C/rpc")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_FLARE_DRPC", "https://flare.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_FLARE_THIRDWEB", "https://14.rpc.thirdweb.com")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_FLARE_ANKR", "https://rpc.ankr.com/flare")},
			},
		},
		// 2026-08-04 audit. Core Chain Bitcoin-aligned L1 (chain 1116). 4 clean keyless
		// providers: core-official (rpc.coredao.org), drpc (core.drpc.org),
		// thirdweb (1116.rpc.thirdweb.com), ankr (rpc.ankr.com/core).
		// Excluded: Alchemy (no route), QuickNode (key required).
		{
			Slug: "core",
			Name: "Core Chain",
			Providers: []Provider{
				{Slug: "core-official", Name: "Core DAO", URL: envDefault("RPC_URL_CORE_OFFICIAL", "https://rpc.coredao.org")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_CORE_DRPC", "https://core.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_CORE_THIRDWEB", "https://1116.rpc.thirdweb.com")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_CORE_ANKR", "https://rpc.ankr.com/core")},
			},
		},
		// 2026-08-04 audit. Fuse Network community DeFi chain (chain 122). 3 clean keyless
		// providers: fuse-official (rpc.fuse.io), drpc (fuse.drpc.org),
		// thirdweb (122.rpc.thirdweb.com). Excluded: Ankr (no route), Alchemy (no route).
		{
			Slug: "fuse",
			Name: "Fuse Network",
			Providers: []Provider{
				{Slug: "fuse-official", Name: "Fuse Foundation", URL: envDefault("RPC_URL_FUSE_OFFICIAL", "https://rpc.fuse.io")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_FUSE_DRPC", "https://fuse.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_FUSE_THIRDWEB", "https://122.rpc.thirdweb.com")},
			},
		},
		// 2026-08-04 wave-5. Filecoin EVM (FEVM, chain 314). 3 keyless providers:
		// glif (api.node.glif.io/rpc/v1), drpc (filecoin.drpc.org),
		// ankr (rpc.ankr.com/filecoin).
		{
			Slug: "filecoin",
			Name: "Filecoin EVM",
			Providers: []Provider{
				{Slug: "glif", Name: "Glif", URL: envDefault("RPC_URL_FILECOIN_GLIF", "https://api.node.glif.io/rpc/v1")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_FILECOIN_DRPC", "https://filecoin.drpc.org")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_FILECOIN_ANKR", "https://rpc.ankr.com/filecoin")},
			},
		},
		// 2026-08-04 wave-5. Canto EVM L1 (chain 7700). 1 keyless provider:
		// canto-official (canto.gravitychain.io). Excluded: dRPC (404),
		// PublicNode (404), Ankr (403 API key required).
		{
			Slug: "canto",
			Name: "Canto",
			Providers: []Provider{
				{Slug: "canto-official", Name: "Canto Official", URL: envDefault("RPC_URL_CANTO_OFFICIAL", "https://canto.gravitychain.io/")},
			},
		},
		// 2026-08-04 wave-5. Aurora EVM on NEAR Protocol (chain 1313161554). 1 keyless
		// provider: aurora-official (mainnet.aurora.dev). Excluded: Ankr (403 API key
		// required), dRPC (403 API key required).
		{
			Slug: "aurora",
			Name: "Aurora",
			Providers: []Provider{
				{Slug: "aurora-official", Name: "Aurora Labs", URL: envDefault("RPC_URL_AURORA_OFFICIAL", "https://mainnet.aurora.dev")},
			},
		},
		// 2026-08-04 wave-5. Bitlayer Bitcoin L2 EVM (chain 200901). 3 keyless
		// providers: bitlayer-official (rpc.bitlayer.org), drpc (bitlayer.drpc.org),
		// ankr (rpc.ankr.com/bitlayer).
		{
			Slug: "bitlayer",
			Name: "Bitlayer",
			Providers: []Provider{
				{Slug: "bitlayer-official", Name: "Bitlayer Official", URL: envDefault("RPC_URL_BITLAYER_OFFICIAL", "https://rpc.bitlayer.org")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_BITLAYER_DRPC", "https://bitlayer.drpc.org")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_BITLAYER_ANKR", "https://rpc.ankr.com/bitlayer")},
			},
		},
		// 2026-08-04 wave-5. B² Network Bitcoin L2 EVM (chain 223). 3 keyless
		// providers: b2-official (rpc.bsquared.network), drpc (b2-mainnet.drpc.org),
		// thirdweb (223.rpc.thirdweb.com).
		{
			Slug: "b2",
			Name: "B² Network",
			Providers: []Provider{
				{Slug: "b2-official", Name: "B² Network Official", URL: envDefault("RPC_URL_B2_OFFICIAL", "https://rpc.bsquared.network")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_B2_DRPC", "https://b2-mainnet.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_B2_THIRDWEB", "https://223.rpc.thirdweb.com")},
			},
		},
		// 2026-08-04 wave-5. dYdX Chain Cosmos app-chain (dydx-mainnet-1). Cosmos SDK
		// Tendermint status probe. 3 keyless providers: publicnode, polkachu, lavenderfive.
		{
			Slug: "dydx",
			Name: "dYdX Chain",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_DYDX_PUBLICNODE", "https://dydx-rpc.publicnode.com")},
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_DYDX_POLKACHU", "https://dydx-rpc.polkachu.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_DYDX_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/dydx")},
			},
		},
		// 2026-08-04 wave-5. Celestia modular DA network (celestia mainnet). Cosmos SDK
		// Tendermint status probe. 3 keyless providers: publicnode, polkachu, lavenderfive.
		{
			Slug: "celestia",
			Name: "Celestia",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_CELESTIA_PUBLICNODE", "https://celestia-rpc.publicnode.com")},
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_CELESTIA_POLKACHU", "https://celestia-rpc.polkachu.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_CELESTIA_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/celestia")},
			},
		},
		// 2026-08-04 wave-6 EVM chains (benches 152-166). eth_getBlockByNumber probe.
		// Boba Network — Optimistic rollup L2 (chain 288). 2 keyless providers.
		{
			Slug: "boba",
			Name: "Boba Network",
			Providers: []Provider{
				{Slug: "boba-official", Name: "Boba Foundation", URL: envDefault("RPC_URL_BOBA_OFFICIAL", "https://mainnet.boba.network")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_BOBA_DRPC", "https://boba-eth.drpc.org")},
			},
		},
		// XDC Network — Enterprise EVM L1 (chain 50). 4 keyless providers.
		// Excluded: dRPC (400 paid plan only).
		{
			Slug: "xdc",
			Name: "XDC Network",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_XDC_PUBLICNODE", "https://rpc.xdc.org")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_XDC_ANKR", "https://rpc.ankr.com/xdc")},
				{Slug: "xdc-erpc", Name: "XDC eRPC", URL: envDefault("RPC_URL_XDC_ERPC", "https://erpc.xinfin.network")},
				{Slug: "xdc-org", Name: "XDC.org", URL: envDefault("RPC_URL_XDC_ORG", "https://rpc.xdc.org")},
			},
		},
		// Astar — Polkadot EVM parachain (chain 592). 2 keyless providers.
		// Excluded: PublicNode (404), BlastAPI (DNS dead).
		{
			Slug: "astar",
			Name: "Astar",
			Providers: []Provider{
				{Slug: "onfinality", Name: "OnFinality", URL: envDefault("RPC_URL_ASTAR_ONFINALITY", "https://astar.api.onfinality.io/public")},
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_ASTAR_1RPC", "https://1rpc.io/astr")},
			},
		},
		// Oasis Sapphire — Confidential EVM paratime (chain 23294). 1 keyless provider.
		// 1RPC dropped: ~15% ok_rate (vs 100% for publicnode), not sustaining continuous probing.
		{
			Slug: "oasis-sapphire",
			Name: "Oasis Sapphire",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_OASIS_SAPPHIRE_PUBLICNODE", "https://sapphire.oasis.io")},
			},
		},
		// Oasis Emerald — EVM paratime (chain 42262). 1 keyless provider.
		// 1RPC dropped: ~15% ok_rate (vs 100% for publicnode), not sustaining continuous probing.
		{
			Slug: "oasis-emerald",
			Name: "Oasis Emerald",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_OASIS_EMERALD_PUBLICNODE", "https://emerald.oasis.io")},
			},
		},
		// Conflux eSpace — Tree-Graph EVM L1 (chain 1030). 3 keyless providers.
		{
			Slug: "conflux",
			Name: "Conflux",
			Providers: []Provider{
				{Slug: "conflux-official", Name: "Conflux Official", URL: envDefault("RPC_URL_CONFLUX_OFFICIAL", "https://evm.confluxrpc.com")},
				{Slug: "conflux-global", Name: "Conflux Global", URL: envDefault("RPC_URL_CONFLUX_GLOBAL", "https://evm.confluxrpc.org")},
				{Slug: "unifra", Name: "Unifra", URL: envDefault("RPC_URL_CONFLUX_UNIFRA", "https://conflux-espace.nodereal.io/v1/pub")},
			},
		},
		// IoTeX — DePIN EVM L1 (chain 4689). 3 keyless providers.
		{
			Slug: "iotex",
			Name: "IoTeX",
			Providers: []Provider{
				{Slug: "iotex-mirror", Name: "IoTeX Mirror", URL: envDefault("RPC_URL_IOTEX_MIRROR", "https://babel-api.mainnet.iotex.one")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_IOTEX_ANKR", "https://rpc.ankr.com/iotex")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_IOTEX_THIRDWEB", "https://4689.rpc.thirdweb.com")},
			},
		},
		// Harmony — Sharded EVM L1 shard 0 (chain 1666600000). 1 keyless provider.
		// 1RPC dropped: ~16% ok_rate vs 100% for harmony-s0.
		{
			Slug: "harmony",
			Name: "Harmony",
			Providers: []Provider{
				{Slug: "harmony-s0", Name: "Harmony S0", URL: envDefault("RPC_URL_HARMONY_S0", "https://a.api.s0.t.hmny.io")},
			},
		},
		// Zircuit — ZK rollup L2 (chain 48900). 1 keyless provider.
		{
			Slug: "zircuit",
			Name: "Zircuit",
			Providers: []Provider{
				{Slug: "zircuit-official", Name: "Zircuit Foundation", URL: envDefault("RPC_URL_ZIRCUIT_OFFICIAL", "https://mainnet.zircuit.com")},
			},
		},
		// Plume — RWA EVM L1 (chain 98866). 2 keyless providers.
		{
			Slug: "plume",
			Name: "Plume",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_PLUME_PUBLICNODE", "https://plume-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_PLUME_DRPC", "https://plume.drpc.org")},
			},
		},
		// Vana — Data economy EVM L1 (chain 1480). 1 keyless provider.
		{
			Slug: "vana",
			Name: "Vana",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_VANA_PUBLICNODE", "https://rpc.vana.org")},
			},
		},
		// Gravity — Galxe EVM L2 (chain 1625). 2 keyless providers.
		{
			Slug: "gravity",
			Name: "Gravity",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_GRAVITY_PUBLICNODE", "https://rpc.gravity.xyz")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_GRAVITY_ANKR", "https://rpc.ankr.com/gravity")},
			},
		},
		// Reya Network — Trading EVM L2 (chain 1729). 2 keyless providers.
		{
			Slug: "reya",
			Name: "Reya Network",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_REYA_PUBLICNODE", "https://rpc.reya.network")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_REYA_THIRDWEB", "https://1729.rpc.thirdweb.com")},
			},
		},
		// 2026-08-04 wave-6 Cosmos SDK chains (benches 167-183). Tendermint status probe.
		// Akash — decentralised cloud compute (akashnet-2). 4 keyless providers.
		{
			Slug: "akash",
			Name: "Akash",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_AKASH_PUBLICNODE", "https://akash-rpc.publicnode.com")},
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_AKASH_POLKACHU", "https://akash-rpc.polkachu.com")},
				{Slug: "ecostake", Name: "EcoStake", URL: envDefault("RPC_URL_AKASH_ECOSTAKE", "https://rpc.cosmos.directory/akash")},
				{Slug: "autostake", Name: "AutoStake", URL: envDefault("RPC_URL_AKASH_AUTOSTAKE", "https://akash-mainnet-rpc.autostake.com:443")},
			},
		},
		// Stride — liquid staking zone (stride-1). 3 keyless providers.
		{
			Slug: "stride",
			Name: "Stride",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_STRIDE_POLKACHU", "https://stride-rpc.polkachu.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_STRIDE_PUBLICNODE", "https://stride-rpc.publicnode.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_STRIDE_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/stride")},
			},
		},
		// Juno — CosmWasm smart contract hub (juno-1). 4 keyless providers.
		{
			Slug: "juno",
			Name: "Juno",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_JUNO_POLKACHU", "https://juno-rpc.polkachu.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_JUNO_PUBLICNODE", "https://juno-rpc.publicnode.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_JUNO_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/juno")},
				{Slug: "autostake", Name: "AutoStake", URL: envDefault("RPC_URL_JUNO_AUTOSTAKE", "https://juno-mainnet-rpc.autostake.com:443")},
			},
		},
		// Axelar — cross-chain network (axelar-dojo-1). 4 keyless providers.
		{
			Slug: "axelar",
			Name: "Axelar",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_AXELAR_POLKACHU", "https://axelar-rpc.polkachu.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_AXELAR_PUBLICNODE", "https://axelar-rpc.publicnode.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_AXELAR_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/axelar")},
				{Slug: "autostake", Name: "AutoStake", URL: envDefault("RPC_URL_AXELAR_AUTOSTAKE", "https://axelar-mainnet-rpc.autostake.com:443")},
			},
		},
		// Dymension — modular RollApp hub (dymension_1100-1). 3 keyless providers.
		{
			Slug: "dymension",
			Name: "Dymension",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_DYMENSION_POLKACHU", "https://dymension-rpc.polkachu.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_DYMENSION_PUBLICNODE", "https://dymension-rpc.publicnode.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_DYMENSION_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/dymension")},
			},
		},
		// Persistence — liquid staking hub (core-1). 3 keyless providers.
		{
			Slug: "persistence",
			Name: "Persistence",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_PERSISTENCE_POLKACHU", "https://persistence-rpc.polkachu.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_PERSISTENCE_PUBLICNODE", "https://persistence-rpc.publicnode.com:443")},
				{Slug: "persistence-official", Name: "Persistence Foundation", URL: envDefault("RPC_URL_PERSISTENCE_OFFICIAL", "https://rpc.core.persistence.one")},
			},
		},
		// Coreum — enterprise RWA chain (coreum-mainnet-1). 3 keyless providers.
		{
			Slug: "coreum",
			Name: "Coreum",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_COREUM_POLKACHU", "https://coreum-rpc.polkachu.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_COREUM_PUBLICNODE", "https://coreum-rpc.publicnode.com")},
				{Slug: "coreum-official", Name: "Coreum Foundation", URL: envDefault("RPC_URL_COREUM_OFFICIAL", "https://full-node.mainnet-1.coreum.dev:26657")},
			},
		},
		// Nolus — DeFi lease protocol (pirin-1). 2 keyless providers.
		{
			Slug: "nolus",
			Name: "Nolus",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_NOLUS_POLKACHU", "https://nolus-rpc.polkachu.com")},
				{Slug: "autostake", Name: "AutoStake", URL: envDefault("RPC_URL_NOLUS_AUTOSTAKE", "https://nolus-mainnet-rpc.autostake.com:443")},
			},
		},
		// Archway — developer-rewards CosmWasm (archway-1). 4 keyless providers.
		{
			Slug: "archway",
			Name: "Archway",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_ARCHWAY_POLKACHU", "https://archway-rpc.polkachu.com")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_ARCHWAY_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/archway")},
				{Slug: "archway-official", Name: "Archway Foundation", URL: envDefault("RPC_URL_ARCHWAY_OFFICIAL", "https://rpc.mainnet.archway.io")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_ARCHWAY_PUBLICNODE", "https://archway-rpc.publicnode.com:443")},
			},
		},
		// Nibiru — CosmWasm + EVM chain (cataclysm-1). 3 keyless providers.
		{
			Slug: "nibiru",
			Name: "Nibiru",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_NIBIRU_POLKACHU", "https://nibiru-rpc.polkachu.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_NIBIRU_PUBLICNODE", "https://nibiru-rpc.publicnode.com:443")},
				{Slug: "nibiru-official", Name: "Nibiru Foundation", URL: envDefault("RPC_URL_NIBIRU_OFFICIAL", "https://rpc.nibiru.fi:443")},
			},
		},
		// Quicksilver — ICS liquid staking (quicksilver-2). 3 keyless providers.
		{
			Slug: "quicksilver",
			Name: "Quicksilver",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_QUICKSILVER_POLKACHU", "https://quicksilver-rpc.polkachu.com")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_QUICKSILVER_PUBLICNODE", "https://quicksilver-rpc.publicnode.com:443")},
				{Slug: "quicksilver-official", Name: "Quicksilver Foundation", URL: envDefault("RPC_URL_QUICKSILVER_OFFICIAL", "https://rpc.quicksilver.zone")},
			},
		},
		// Terra 2 — relaunched Cosmos chain (phoenix-1). 4 keyless providers.
		{
			Slug: "terra",
			Name: "Terra",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_TERRA_POLKACHU", "https://terra-rpc.polkachu.com:443")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_TERRA_PUBLICNODE", "https://terra-rpc.publicnode.com:443")},
				{Slug: "lavenderfive", Name: "LavenderFive", URL: envDefault("RPC_URL_TERRA_LAVENDERFIVE", "https://rpc.lavenderfive.com:443/terra2")},
				{Slug: "autostake", Name: "AutoStake", URL: envDefault("RPC_URL_TERRA_AUTOSTAKE", "https://terra-mainnet-rpc.autostake.com:443")},
			},
		},
		// Regen Network — ecological assets chain (regen-1). 2 keyless providers.
		{
			Slug: "regen",
			Name: "Regen Network",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "polkachu", Name: "Polkachu", URL: envDefault("RPC_URL_REGEN_POLKACHU", "https://regen-rpc.polkachu.com:443")},
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_REGEN_PUBLICNODE", "https://regen-rpc.publicnode.com:443")},
			},
		},
		// Comdex — DeFi synthetics chain (comdex-1). 1 keyless provider.
		{
			Slug: "comdex",
			Name: "Comdex",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "stavr", Name: "STAVR", URL: envDefault("RPC_URL_COMDEX_STAVR", "https://comdex.rpc.m.stavr.tech:443")},
			},
		},
		// Fantom — EVM (chain 250). 3 keyless providers.
		{
			Slug: "fantom",
			Name: "Fantom",
			Providers: []Provider{
				{Slug: "fantom-official", Name: "Fantom Foundation", URL: envDefault("RPC_URL_FANTOM_OFFICIAL", "https://rpcapi.fantom.network")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_FANTOM_DRPC", "https://fantom.drpc.org")},
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_FANTOM_THIRDWEB", "https://250.rpc.thirdweb.com")},
			},
		},
		// Kusama — Polkadot canary relay chain. 3 keyless providers.
		{
			Slug: "kusama",
			Name: "Kusama",
			Kind: "polkadot",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_KUSAMA_PUBLICNODE", "https://kusama-rpc.publicnode.com")},
				{Slug: "onfinality", Name: "OnFinality", URL: envDefault("RPC_URL_KUSAMA_ONFINALITY", "https://kusama.api.onfinality.io/public")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_KUSAMA_DRPC", "https://kusama.drpc.org")},
			},
		},
		// Hydration — Polkadot DeFi parachain (HydraDX). All providers dead
		// (DNS dead or HTTP 400). Chain suspended from active probing.
		// ZetaChain — EVM omnichain L1 (chain 7000). 1 keyless provider.
		// Excluded: BlockPI (404), AllThatNode (DNS dead).
		{
			Slug: "zetachain",
			Name: "ZetaChain",
			Providers: []Provider{
				{Slug: "thirdweb", Name: "Thirdweb", URL: envDefault("RPC_URL_ZETACHAIN_THIRDWEB", "https://7000.rpc.thirdweb.com")},
			},
		},
		// HAQQ — EVM Islamic finance L1 (chain 11235). 3 keyless providers.
		{
			Slug: "haqq",
			Name: "HAQQ",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_HAQQ_PUBLICNODE", "https://haqq-evm-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_HAQQ_DRPC", "https://haqq.drpc.org")},
				{Slug: "haqq-official", Name: "HAQQ Foundation", URL: envDefault("RPC_URL_HAQQ_OFFICIAL", "https://rpc.eth.haqq.network")},
			},
		},
		// Etherlink — Tezos EVM L2 (chain 42793). 2 keyless providers.
		{
			Slug: "etherlink",
			Name: "Etherlink",
			Providers: []Provider{
				{Slug: "etherlink-official", Name: "Etherlink Foundation", URL: envDefault("RPC_URL_ETHERLINK_OFFICIAL", "https://node.mainnet.etherlink.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ETHERLINK_DRPC", "https://etherlink.drpc.org")},
			},
		},
		// Chiliz — Sports fan token EVM (chain 88888). 3 keyless providers.
		{
			Slug: "chiliz",
			Name: "Chiliz",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_CHILIZ_PUBLICNODE", "https://chiliz-rpc.publicnode.com")},
				{Slug: "ankr", Name: "Ankr", URL: envDefault("RPC_URL_CHILIZ_ANKR", "https://rpc.ankr.com/chiliz")},
				{Slug: "chiliz-official", Name: "Chiliz Foundation", URL: envDefault("RPC_URL_CHILIZ_OFFICIAL", "https://rpc.chiliz.com")},
			},
		},
		// WEMIX — Korean web3 gaming EVM (chain 1111). 2 keyless providers.
		{
			Slug: "wemix",
			Name: "WEMIX",
			Providers: []Provider{
				{Slug: "wemix-official", Name: "WeMade", URL: envDefault("RPC_URL_WEMIX_OFFICIAL", "https://api.wemix.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_WEMIX_DRPC", "https://wemix.drpc.org")},
			},
		},
		// Songbird — Flare canary network (chain 19). 1 keyless provider.
		// Excluded: ftso-au (DNS dead).
		{
			Slug: "songbird",
			Name: "Songbird",
			Providers: []Provider{
				{Slug: "flare-official", Name: "Flare Foundation", URL: envDefault("RPC_URL_SONGBIRD_FLARE", "https://songbird-api.flare.network/ext/C/rpc")},
			},
		},
		// Cronos zkEVM — zkSync-stack Cronos L2 (chain 388). 2 keyless providers.
		{
			Slug: "cronos-zkevm",
			Name: "Cronos zkEVM",
			Providers: []Provider{
				{Slug: "cronos-zkevm-official", Name: "Crypto.com Foundation", URL: envDefault("RPC_URL_CRONOS_ZKEVM_OFFICIAL", "https://mainnet.zkevm.cronos.org")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_CRONOS_ZKEVM_DRPC", "https://cronos-zkevm.drpc.org")},
			},
		},
		// Ethereum Classic — Original Ethereum chain (chain 61). 3 keyless providers.
		{
			Slug: "ethereum-classic",
			Name: "Ethereum Classic",
			Providers: []Provider{
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ETC_DRPC", "https://etc.drpc.org")},
				{Slug: "etcdesktop", Name: "ETC Desktop", URL: envDefault("RPC_URL_ETC_ETCDESKTOP", "https://rpc.etcdesktop.com")},
				{Slug: "etcmc", Name: "ETCMC", URL: envDefault("RPC_URL_ETC_ETCMC", "https://etcmc.rpc.nz")},
			},
		},
		// Telos EVM — High-performance EVM (chain 40). 1 keyless provider.
		// Excluded: telos-official (404).
		{
			Slug: "telos",
			Name: "Telos",
			Providers: []Provider{
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_TELOS_DRPC", "https://telos.drpc.org")},
			},
		},
		// PulseChain — Full-state Ethereum fork (chain 369). 3 keyless providers.
		{
			Slug: "pulsechain",
			Name: "PulseChain",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_PULSECHAIN_PUBLICNODE", "https://pulsechain-rpc.publicnode.com")},
				{Slug: "pulsechain-official", Name: "PulseChain Foundation", URL: envDefault("RPC_URL_PULSECHAIN_OFFICIAL", "https://rpc.pulsechain.com")},
				{Slug: "g4mm4", Name: "G4MM4", URL: envDefault("RPC_URL_PULSECHAIN_G4MM4", "https://rpc-pulsechain.g4mm4.io")},
			},
		},
		// Warden Protocol — Intent-based EVM L1. 2 keyless providers.
		{
			Slug: "warden",
			Name: "Warden Protocol",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_WARDEN_PUBLICNODE", "https://warden-evm-rpc.publicnode.com")},
				{Slug: "warden-official", Name: "Warden Foundation", URL: envDefault("RPC_URL_WARDEN_OFFICIAL", "https://evm.wardenprotocol.org")},
			},
		},
		// Oraichain — AI-focused Cosmos SDK chain. 2 keyless providers.
		{
			Slug: "oraichain",
			Name: "Oraichain",
			Kind: "cosmos",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_ORAICHAIN_PUBLICNODE", "https://oraichain-rpc.publicnode.com")},
				{Slug: "orai-official", Name: "Orai Foundation", URL: envDefault("RPC_URL_ORAICHAIN_OFFICIAL", "https://rpc.orai.io")},
			},
		},
		// Peaq Network — DePIN Polkadot parachain. 2 keyless providers.
		{
			Slug: "peaq",
			Name: "Peaq Network",
			Kind: "polkadot",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_PEAQ_PUBLICNODE", "https://peaq-rpc.publicnode.com")},
				{Slug: "onfinality", Name: "OnFinality", URL: envDefault("RPC_URL_PEAQ_ONFINALITY", "https://peaq.api.onfinality.io/public")},
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
