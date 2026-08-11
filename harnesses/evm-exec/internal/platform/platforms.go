package platform

import (
	"strings"
)

// EVMPlatform describes what to monitor for one platform on one chain.
type EVMPlatform struct {
	FeeCollector   string   // lowercase 42-char 0x address
	NativeEnabled  bool     // collect native asset (ETH / BNB)
	ERC20Tokens    []string // lowercase ERC-20 contracts to monitor
	BootstrapDays  int      // how many days back to seed cursor on first run
}

// USDC contract addresses, lowercase.
const (
	USDC_ETH  = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" // 6 decimals
	USDC_BSC  = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" // 18 decimals (Binance-Peg)
	USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" // 6 decimals
)

// TokenDecimals maps known token addresses to their decimal places.
var TokenDecimals = map[string]int{
	USDC_ETH:  6,
	USDC_BSC:  18,
	USDC_BASE: 6,
}

// NativeSymbol returns the native asset symbol for a chain.
func NativeSymbol(chain string) string {
	if chain == "bsc" {
		return "BNB"
	}
	return "ETH"
}

// BlocksPerDay is the approximate number of blocks produced per day per chain.
var BlocksPerDay = map[string]uint64{
	"ethereum": 7_200,
	"bsc":      28_800,
	"base":     43_200,
}

// PlatformConfig maps platform → chain → configuration.
var PlatformConfig = map[string]map[string]EVMPlatform{
	// pump.fun Terminal (acquired Terminal.fun/Padre Oct 2025) — confirmed via DeFiLlama
	"pumpfun": {
		"ethereum": {
			FeeCollector:  "0xa74fa823bc8617fa320a966b3d11b0f722ef09ee",
			NativeEnabled: true,
			ERC20Tokens:   []string{USDC_ETH},
			BootstrapDays: 30,
		},
		"bsc": {
			FeeCollector:  "0x2b0a28a0a9197f8af5d1b8371c048e92dd78b640",
			NativeEnabled: true,
			ERC20Tokens:   []string{USDC_BSC},
			BootstrapDays: 30,
		},
		"base": {
			FeeCollector:  "0x16388de42c5829fd0e88c8eb001ef43bfc93f177",
			NativeEnabled: false, // no free trace API on Base; USDC only
			ERC20Tokens:   []string{USDC_BASE},
			BootstrapDays: 30,
		},
	},
	"gmgn": {
		"ethereum": {
			FeeCollector:  "0xb8159ba378904f803639d274cec79f788931c9c8",
			NativeEnabled: true,
			ERC20Tokens:   []string{USDC_ETH},
			BootstrapDays: 30,
		},
		"bsc": {
			FeeCollector:  "0xb8159ba378904f803639d274cec79f788931c9c8",
			NativeEnabled: true,
			ERC20Tokens:   []string{USDC_BSC},
			BootstrapDays: 30,
		},
		"base": {
			FeeCollector:  "0xb8159ba378904f803639d274cec79f788931c9c8",
			NativeEnabled: false, // no free trace API; USDC only
			ERC20Tokens:   []string{USDC_BASE},
			BootstrapDays: 30,
		},
	},
}

// Coverage returns "full" if native is enabled for this platform+chain, else "stable-only".
func Coverage(platform, chain string) string {
	chains, ok := PlatformConfig[platform]
	if !ok {
		return "stable-only"
	}
	cfg, ok := chains[chain]
	if !ok {
		return "stable-only"
	}
	if cfg.NativeEnabled {
		return "full"
	}
	return "stable-only"
}

func init() {
	for plt, chains := range PlatformConfig {
		for chain, cfg := range chains {
			mustAddr(cfg.FeeCollector, plt+"/"+chain+"/FeeCollector")
			for _, t := range cfg.ERC20Tokens {
				mustAddr(t, plt+"/"+chain+"/ERC20Token")
			}
		}
	}
	for addr := range TokenDecimals {
		mustAddr(addr, "TokenDecimals key")
	}
}

func mustAddr(a, label string) {
	if len(a) != 42 || !strings.HasPrefix(a, "0x") || a != strings.ToLower(a) {
		panic("invalid address in platform config [" + label + "]: " + a)
	}
}
