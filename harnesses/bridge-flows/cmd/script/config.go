package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Chain is one CCTP source chain the harness scans. Every field is public
// protocol data: Circle's TokenMessenger contracts per chain and the native
// USDC address whose burns count (EURC also moves over CCTP and is excluded
// by the burnToken filter).
//
// v1 addresses verified 2026-09-25 by reading DepositForBurn logs off each
// contract over the last six hours (Ethereum 52, Polygon 14, Avalanche 19,
// Arbitrum 8, Base 2, Optimism 2; Unichain 0 in the window, address from
// Circle's v1 table). TokenMessengerV2 is the same address on every EVM
// chain per developers.circle.com/cctp/evm-smart-contracts.
type Chain struct {
	Slug     string // OCB chain slug (src/lib/chains.ts)
	Domain   uint32 // CCTP domain id
	USDC     string // native USDC on the chain, lowercase
	V1       string // TokenMessenger (v1), lowercase, empty when absent
	V2       string // TokenMessengerV2, lowercase
	RPCs     []string
	MaxChunk int64  // blocks per eth_getLogs the first RPC accepted on 2026-09-25
	L2Beat   string // L2Beat project id for the TVS delta, empty when not an L2
}

const tokenMessengerV2 = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"

// Public RPCs that answered eth_getLogs over thousands of blocks from the
// OCB VPS on 2026-09-25 (Tenderly public gateways first, the chain's official
// endpoint second). dRPC public answers 400 to this client and publicnode,
// 1rpc, ankr, llamarpc and blockpi refuse getLogs, so none of them are
// listed. Override per chain with BRIDGE_FLOWS_RPC_<SLUG> (comma separated).
var defaultChains = []Chain{
	{Slug: "ethereum", Domain: 0, USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", V1: "0xbd3fa81b58ba92a82136038b25adec7066af3155", V2: tokenMessengerV2,
		RPCs: []string{"https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"}, MaxChunk: 1500},
	{Slug: "base", Domain: 6, USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", V1: "0x1682ae6375c4e4a97e4b583bc394c861a46d8962", V2: tokenMessengerV2,
		RPCs: []string{"https://mainnet.base.org", "https://gateway.tenderly.co/public/base"}, MaxChunk: 2000, L2Beat: "base"},
	{Slug: "arbitrum", Domain: 3, USDC: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", V1: "0x19330d10d9cc8751218eaf51e8885d058642e08a", V2: tokenMessengerV2,
		RPCs: []string{"https://gateway.tenderly.co/public/arbitrum", "https://arb1.arbitrum.io/rpc"}, MaxChunk: 20000, L2Beat: "arbitrum"},
	{Slug: "optimism", Domain: 2, USDC: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", V1: "0x2b4069517957735be00cee0fadae88a26365528f", V2: tokenMessengerV2,
		// L2Beat's summary keys Optimism as "optimism" but its chart route is
		// "op-mainnet" (the former answers "Project not found", 2026-09-25).
		RPCs: []string{"https://gateway.tenderly.co/public/optimism", "https://mainnet.optimism.io"}, MaxChunk: 10000, L2Beat: "op-mainnet"},
	{Slug: "polygon", Domain: 7, USDC: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", V1: "0x9daf8c91aefae50b9c0e69629d3f6ca40ca3b3fe", V2: tokenMessengerV2,
		RPCs: []string{"https://gateway.tenderly.co/public/polygon"}, MaxChunk: 10000, L2Beat: "polygon-pos"},
	{Slug: "avalanche", Domain: 1, USDC: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", V1: "0x6b25532e1060ce10cc3b0a99e5683b91bfde6982", V2: tokenMessengerV2,
		RPCs: []string{"https://gateway.tenderly.co/public/avalanche", "https://api.avax.network/ext/bc/C/rpc"}, MaxChunk: 10000},
	{Slug: "unichain", Domain: 10, USDC: "0x078d782b760474a361dda0af3839290b0ef57ad6", V1: "0x4e744b28e787c3ad0e810ed65a24461d4ac5a762", V2: tokenMessengerV2,
		RPCs: []string{"https://gateway.tenderly.co/public/unichain", "https://mainnet.unichain.org"}, MaxChunk: 10000, L2Beat: "unichain"},
}

// CCTP destination domains, from Circle's supported-blockchains table
// (developers.circle.com/cctp/cctp-supported-blockchains, read 2026-09-25;
// 4 Noble and 8 Sui are v1-only). Domains the registry does not scan as
// sources still appear as destinations of the scanned chains' burns; an
// id missing here publishes as "domain-<id>".
var domainSlug = map[uint32]string{
	0: "ethereum", 1: "avalanche", 2: "optimism", 3: "arbitrum", 4: "noble", 5: "solana", 6: "base", 7: "polygon",
	8: "sui", 9: "aptos", 10: "unichain", 11: "linea", 12: "codex", 13: "sonic", 14: "world", 15: "monad", 16: "sei",
	17: "bnb", 18: "xdc", 19: "hyperevm", 21: "ink", 22: "plume", 25: "starknet", 26: "arc", 27: "stellar",
	28: "edge", 29: "injective", 30: "morph", 31: "pharos", 32: "cronos", 33: "plasma", 37: "xlayer",
}

// Wormhole chain ids to OCB slugs, from the Wormhole TypeScript SDK
// constants (core/base/src/constants/chains.ts, read 2026-09-25). Ids the
// map does not know publish as "wormhole-<id>".
var wormholeSlug = map[string]string{
	"1": "solana", "2": "ethereum", "4": "bnb", "5": "polygon", "6": "avalanche", "10": "fantom", "14": "celo",
	"21": "sui", "22": "aptos", "23": "arbitrum", "24": "optimism", "30": "base", "34": "scroll", "35": "mantle",
	"37": "xlayer", "38": "linea", "39": "berachain", "40": "seievm", "44": "unichain", "45": "worldchain",
	"46": "ink", "47": "hyperevm", "48": "monad", "50": "mezo", "51": "fogo", "52": "sonic", "53": "converge",
	"55": "plume", "57": "xrplevm", "58": "plasma", "59": "creditcoin", "60": "stacks", "63": "moca",
	"64": "megaeth", "66": "xrpl", "67": "zerogravity", "68": "tempo", "69": "nexus", "71": "arc", "72": "robinhood",
	"73": "hydration", "3104": "wormchain", "4000": "cosmos-hub", "4003": "neutron", "4004": "celestia", "4009": "noble",
}

type Config struct {
	Chains        []Chain
	Tick          time.Duration
	Addr          string
	StateFile     string
	HistoryHours  int // hours of hourly buckets kept: 7d window plus slack
	RequestGap    time.Duration
	WormholeEvery time.Duration
	L2BeatEvery   time.Duration
}

func envDur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func loadConfig() Config {
	chains := make([]Chain, 0, len(defaultChains))
	for _, c := range defaultChains {
		if v := os.Getenv("BRIDGE_FLOWS_RPC_" + strings.ToUpper(c.Slug)); v != "" {
			var urls []string
			for _, u := range strings.Split(v, ",") {
				if u = strings.TrimSpace(u); u != "" {
					urls = append(urls, u)
				}
			}
			if len(urls) > 0 {
				c.RPCs = urls
			}
		}
		chains = append(chains, c)
	}
	addr := os.Getenv("METRICS_ADDR")
	if addr == "" {
		addr = ":2112"
	}
	state := os.Getenv("STATE_FILE")
	if state == "" {
		state = "/data/state.json"
	}
	return Config{
		Chains:        chains,
		Tick:          envDur("TICK", 30*time.Minute),
		Addr:          addr,
		StateFile:     state,
		HistoryHours:  envInt("HISTORY_HOURS", 8*24),
		RequestGap:    envDur("REQUEST_GAP", 120*time.Millisecond),
		WormholeEvery: envDur("WORMHOLE_EVERY", time.Hour),
		L2BeatEvery:   envDur("L2BEAT_EVERY", time.Hour),
	}
}
