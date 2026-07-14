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
	// Kind selects the probe path: "" (EVM, eth_getBlockByNumber) or
	// "solana" (getSlot at processed commitment, slot-based staleness,
	// no archive-depth loop).
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
				{Slug: "solana-official", Name: "Solana Labs", URL: envDefault("RPC_URL_SOLANA_OFFICIAL", "https://api.mainnet-beta.solana.com")},
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
