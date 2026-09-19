package main

import (
	"os"
	"time"
)

type ChainKind string

const (
	KindEVM     ChainKind = "evm"
	KindSolana  ChainKind = "solana"
	KindCardano ChainKind = "cardano"
	KindStellar ChainKind = "stellar"
	KindTron    ChainKind = "tron"
	KindSui     ChainKind = "sui"
	KindTon     ChainKind = "ton"
	KindUTXO    ChainKind = "utxo"
	KindMonero  ChainKind = "monero"
)

// ChainConfig describes one chain whose native-transfer fee we sample.
//
// Same list as the L1 finality bench. The fetcher per Kind decides how to
// produce a "current cost of a standard native transfer" sample in the
// chain's native units; the orchestrator multiplies by the USD price from
// Mobula to get the comparable headline `tx_fee_native_transfer_usd`.
type ChainConfig struct {
	Slug       string    // stable label, used both for Prom + Mobula price lookup
	Name       string    // display name
	Kind       ChainKind // selects fetcher
	RPCURL     string    // primary endpoint (per-kind semantics)
	MobulaSlug string    // asset slug for Mobula price API (e.g. "ethereum", "toncoin")
	// Tier is meaningful only for chains with a priority market.
	// Deterministic chains (Cardano, Stellar) ignore it and emit one tier.
	HasPriorityMarket bool
	Layer             string // "l1" or "l2" — Prom label so dashboards can split L1 vs L2.
	// L1Fee selects how the rollup's L1 data-posting cost is added to the
	// L2 execution fee so the headline is the wallet-visible total:
	//   ""          none (L1 chains, or rollups whose gas price already
	//               embeds the data cost: zkSync pubdata, Taiko, Linea)
	//   "opstack"   GasPriceOracle predeploy 0x42..0F getL1Fee(bytes) on
	//               a serialized 21000-gas EIP-1559 transfer (Optimism,
	//               Base, Blast, Mantle)
	//   "scroll"    L1GasPriceOracle 0x53..02 getL1Fee(bytes)
	//   "arbitrum"  eth_estimateGas on a native transfer, which Nitro
	//               inflates by the L1 calldata component, times the gas
	//               price
	L1Fee string
}

type Config struct {
	Chains       []ChainConfig
	Interval     time.Duration
	PriceRefresh time.Duration
	MobulaAPIKey string
}

func loadConfig() *Config {
	return &Config{
		Interval:     30 * time.Second,
		PriceRefresh: 30 * time.Second,
		MobulaAPIKey: getenvDefault("MOBULA_API_KEY", ""),
		Chains: []ChainConfig{
			// EVM L1 — generic eth_feeHistory + 21000 gas for native transfer.
			{
				Slug:              "ethereum",
				Name:              "Ethereum",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_ETHEREUM", "https://ethereum.publicnode.com"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l1",
			},
			{
				Slug:              "bnb",
				Name:              "BNB Chain",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_BNB", "https://bsc-rpc.publicnode.com"),
				MobulaSlug:        "bnb",
				HasPriorityMarket: true,
				Layer:             "l1",
			},
			{
				Slug:              "avalanche",
				Name:              "Avalanche",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_AVALANCHE", "https://api.avax.network/ext/bc/C/rpc"),
				MobulaSlug:        "avalanche",
				HasPriorityMarket: true,
				Layer:             "l1",
			},
			// Non-EVM L1.
			{
				Slug:              "solana",
				Name:              "Solana",
				Kind:              KindSolana,
				RPCURL:            getenvDefault("RPC_SOLANA", "https://api.mainnet-beta.solana.com"),
				MobulaSlug:        "solana",
				HasPriorityMarket: true,
				Layer:             "l1",
			},
			{
				Slug:              "tron",
				Name:              "TRON",
				Kind:              KindTron,
				RPCURL:            getenvDefault("RPC_TRON", "https://api.trongrid.io"),
				MobulaSlug:        "tron",
				HasPriorityMarket: false,
				Layer:             "l1",
			},
			{
				Slug:              "cardano",
				Name:              "Cardano",
				Kind:              KindCardano,
				RPCURL:            getenvDefault("RPC_CARDANO", "https://api.koios.rest/api/v1"),
				MobulaSlug:        "cardano",
				HasPriorityMarket: false,
				Layer:             "l1",
			},
			{
				Slug:              "stellar",
				Name:              "Stellar",
				Kind:              KindStellar,
				RPCURL:            getenvDefault("RPC_STELLAR", "https://horizon.stellar.org"),
				MobulaSlug:        "stellar",
				HasPriorityMarket: false,
				Layer:             "l1",
			},
			{
				Slug:              "gram",
				Name:              "Gram",
				Kind:              KindTon,
				RPCURL:            getenvDefault("RPC_GRAM", "https://toncenter.com/api/v2/jsonRPC"),
				MobulaSlug:        "toncoin",
				HasPriorityMarket: false,
				Layer:             "l1",
			},
			{
				Slug:              "sui",
				Name:              "Sui",
				Kind:              KindSui,
				RPCURL:            getenvDefault("RPC_SUI", "https://graphql.mainnet.sui.io/graphql"),
				MobulaSlug:        "sui",
				HasPriorityMarket: true,
				Layer:             "l1",
			},
			{
				Slug:              "litecoin",
				Name:              "Litecoin",
				Kind:              KindUTXO,
				RPCURL:            getenvDefault("RPC_LITECOIN", "https://litecoinspace.org/api"),
				MobulaSlug:        "litecoin",
				HasPriorityMarket: true,
				Layer:             "l1",
			},
			{
				Slug:              "monero",
				Name:              "Monero",
				Kind:              KindMonero,
				RPCURL:            getenvDefault("RPC_MONERO", "https://xmr-node.cakewallet.com:18081"),
				MobulaSlug:        "monero",
				HasPriorityMarket: true,
				Layer:             "l1",
			},
			// EVM L2 — reuse the generic eth_feeHistory fetcher from evm.go.
			// All bill gas in ETH (Mantle switched from MNT to ETH in 2026),
			// so MobulaSlug=ethereum across the board.
			{
				Slug:              "arbitrum",
				Name:              "Arbitrum One",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_ARBITRUM", "https://arbitrum-one-rpc.publicnode.com"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l2",
				L1Fee:             "arbitrum",
			},
			{
				Slug:              "robinhood",
				Name:              "Robinhood Chain",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_ROBINHOOD", "https://rpc.mainnet.chain.robinhood.com"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l2",
			},
			{
				Slug:              "base",
				Name:              "Base",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_BASE", "https://base-rpc.publicnode.com"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l2",
				L1Fee:             "opstack",
			},
			{
				Slug:              "optimism",
				Name:              "Optimism",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_OPTIMISM", "https://optimism-rpc.publicnode.com"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l2",
				L1Fee:             "opstack",
			},
			{
				Slug:              "blast",
				Name:              "Blast",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_BLAST", "https://rpc.blast.io"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l2",
				L1Fee:             "opstack",
			},
			{
				Slug:              "scroll",
				Name:              "Scroll",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_SCROLL", "https://scroll-rpc.publicnode.com"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l2",
				L1Fee:             "scroll",
			},
			{
				Slug:              "zksync",
				Name:              "zkSync Era",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_ZKSYNC", "https://mainnet.era.zksync.io"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l2",
			},
			{
				Slug:              "linea",
				Name:              "Linea",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_LINEA", "https://linea-rpc.publicnode.com"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l2",
			},
			{
				// Mantle prices gas in MNT, not ETH. eth_feeHistory returns
				// MNT-denominated gas prices, so we feed the MNT USD price.
				Slug:              "mantle",
				Name:              "Mantle",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_MANTLE", "https://mantle-rpc.publicnode.com"),
				MobulaSlug:        "mantle",
				HasPriorityMarket: true,
				Layer:             "l2",
				L1Fee:             "opstack",
			},
			{
				Slug:              "taiko",
				Name:              "Taiko",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_TAIKO", "https://taiko-rpc.publicnode.com"),
				MobulaSlug:        "ethereum",
				HasPriorityMarket: true,
				Layer:             "l2",
			},
			{
				// HyperEVM bills gas in HYPE (Hyperliquid's native token).
				// eth_feeHistory returns HYPE-denominated gas prices, so
				// the conversion uses the HYPE USD price feed.
				Slug:              "hyperevm",
				Name:              "HyperEVM",
				Kind:              KindEVM,
				RPCURL:            getenvDefault("RPC_HYPEREVM", "https://rpc.hyperliquid.xyz/evm"),
				MobulaSlug:        "hyperliquid",
				HasPriorityMarket: true,
				Layer:             "l2",
			},
		},
	}
}

func getenvDefault(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
