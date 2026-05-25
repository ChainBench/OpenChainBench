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
// without a key).
func chains() []Chain {
	return []Chain{
		// ─── Ethereum mainnet (9 providers) ────────────────────────
		{
			Slug: "ethereum",
			Name: "Ethereum",
			Providers: []Provider{
				{Slug: "publicnode", Name: "PublicNode", URL: envDefault("RPC_URL_ETHEREUM_PUBLICNODE", "https://ethereum-rpc.publicnode.com")},
				{Slug: "drpc", Name: "dRPC", URL: envDefault("RPC_URL_ETHEREUM_DRPC", "https://eth.drpc.org")},
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_ETHEREUM_1RPC", "https://1rpc.io/eth")},
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
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_POLYGON_1RPC", "https://1rpc.io/matic")},
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
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_ARBITRUM_1RPC", "https://1rpc.io/arb")},
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
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_OPTIMISM_1RPC", "https://1rpc.io/op")},
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
				{Slug: "merkle", Name: "Merkle", URL: envDefault("RPC_URL_BASE_MERKLE", "https://base.merkle.io")},
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
				{Slug: "merkle", Name: "Merkle", URL: envDefault("RPC_URL_BNB_MERKLE", "https://bsc.merkle.io")},
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
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_AVALANCHE_1RPC", "https://1rpc.io/avax/c")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_AVALANCHE_TENDERLY", "https://gateway.tenderly.co/public/avalanche")},
				{Slug: "nodies", Name: "Nodies (POKT)", URL: envDefault("RPC_URL_AVALANCHE_NODIES", "https://avax-pokt.nodies.app/ext/bc/C/rpc")},
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
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_LINEA_1RPC", "https://1rpc.io/linea")},
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
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_SCROLL_1RPC", "https://1rpc.io/scroll")},
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
				{Slug: "1rpc", Name: "1RPC", URL: envDefault("RPC_URL_MANTLE_1RPC", "https://1rpc.io/mantle")},
				{Slug: "tenderly", Name: "Tenderly Gateway", URL: envDefault("RPC_URL_MANTLE_TENDERLY", "https://gateway.tenderly.co/public/mantle")},
			},
		},
	}
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
