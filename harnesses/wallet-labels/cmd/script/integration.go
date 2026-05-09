package main

// Integration smoke test triggered with `script --test`. Runs every
// provider against a curated set of well-known addresses and prints a
// comparison table. Useful before deploying.

import (
	"context"
	"fmt"
	"os"
	"time"
)

type testCase struct {
	chain   string
	address string
	expect  string
}

var integrationCases = []testCase{
	// EVM
	{"ethereum", "0x28C6c06298d514Db089934071355E5743bf21d60", "Binance Hot Wallet 14"},
	{"ethereum", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "vitalik.eth"},
	{"ethereum", "0xa160cdAB225685dA1d56aa342Ad8841c3b53f291", "Tornado Cash 100 ETH (sanctioned)"},
	{"base", "0x4200000000000000000000000000000000000006", "WETH (Base)"},
	{"bnb", "0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance Hot 8 (BSC)"},
	// Solana
	{"solana", "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "Raydium Authority"},
	// TON
	{"ton", "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt", "STON.fi DEX"},
	// Stellar
	{"stellar", "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A", "Binance"},
	// XRP
	{"xrp", "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv", "Bitstamp"},
	// Bitcoin
	{"bitcoin", "1HckjUpRGcrrRAtFaaCAUaGjsPx9oYmLaZ", "Huobi-2 (per WalletExplorer)"},
}

func runIntegrationTest(cfg *Config, providers []Provider) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	fmt.Println()
	fmt.Println("=== Provider integration test ===")
	for _, tc := range integrationCases {
		fmt.Printf("\n--- %s / %s…%s (expect: %s) ---\n",
			tc.chain, tc.address[:6], tc.address[len(tc.address)-4:], tc.expect)
		for _, p := range providers {
			if !p.Supports(tc.chain) {
				continue
			}
			fmt.Printf("  → calling %s...\n", p.Name())
			os.Stdout.Sync()
			var r LabelResult
			func() {
				defer func() {
					if rec := recover(); rec != nil {
						fmt.Printf("  PANIC in %s: %v\n", p.Name(), rec)
					}
				}()
				ctx2, cancel2 := context.WithTimeout(ctx, 45*time.Second)
				r = p.Lookup(ctx2, tc.chain, tc.address)
				cancel2()
			}()
			mark := "✗"
			if r.HasLabel {
				mark = "✓"
			}
			errStr := ""
			if r.Err != nil {
				errStr = "  ERR=" + r.Err.Error()
			}
			fmt.Printf("  %-15s %s  %-32s  %5dms%s\n",
				p.Name(), mark, trim(r.Label, 32), r.LatencyMs, errStr)
		}
	}
	fmt.Println()
}
