package main

import (
	"os"
	"strings"
	"time"
)

// xstocks-peg: Backed's xStocks tokenized equities on Solana vs their
// Yahoo reference, deviation in bps, session-labeled. Same metric
// contract as the Robinhood harness (tsp_* family) with
// issuer="xstocks", so cross-issuer comparisons are pure PromQL.
//
// Price read: Jupiter lite-api swap quotes in BOTH directions per
// symbol (sell 1 share to USDC, buy with the equivalent USDC); the mid
// is the executable peg price, immune to the price/v3 drift observed
// on thin routes (PLTRx v3 was $1.93 off its executable quote).
// The Token-2022 ScaledUiAmount multiplier (7 of 12 mints carry one,
// 1.0017 to 1.0059 on 2026-09-23, rising as dividends accrue in kind)
// is read on-chain from each mint's scaledUiAmountConfig every tick
// (one getMultipleAccounts call; Jupiter's scaledUiConfig as fallback);
// a scaled mint without a multiplier this tick is not priced.
//
// Cohort: 12 xStocks with verified Jupiter routes at 1-share impact
// under 2bp (2026-07-13). All mints 8 decimals.

const (
	usdcMint        = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	oneShareRaw     = 100000000 // 1e8 = 1 share at 8 decimals, pre-multiplier
	pollInterval    = 60 * time.Second
	httpTimeout     = 15 * time.Second
	quoteGap        = 1100 * time.Millisecond // lite tier: stay well under 60 req/min
	issuerLabel     = "xstocks"
	logThresholdBps = 100.0
)

type Asset struct {
	Symbol string // Yahoo ticker (HOODx maps to HOOD, etc.)
	Mint   string
	// Scaled marks a Token-2022 mint with the ScaledUiAmount extension:
	// 1e8 raw units are `multiplier` shares, and the multiplier must be
	// read every tick or the mint is not priced.
	Scaled bool
}

var assets = []Asset{
	{Symbol: "TSLA", Mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"},
	{Symbol: "NVDA", Mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", Scaled: true},
	{Symbol: "AAPL", Mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", Scaled: true},
	{Symbol: "MSFT", Mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", Scaled: true},
	{Symbol: "AMZN", Mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg"},
	{Symbol: "GOOGL", Mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", Scaled: true},
	{Symbol: "META", Mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", Scaled: true},
	{Symbol: "HOOD", Mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg"},
	{Symbol: "SPY", Mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", Scaled: true},
	{Symbol: "QQQ", Mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", Scaled: true},
	{Symbol: "COIN", Mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu"},
	{Symbol: "PLTR", Mint: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4"},
}

func listenAddr() string {
	if v := strings.TrimSpace(os.Getenv("LISTEN_ADDR")); v != "" {
		return v
	}
	return ":2112"
}
