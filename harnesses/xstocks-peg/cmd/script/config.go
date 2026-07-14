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
// A single batched price/v3 call per tick supplies the Token-2022
// ScaledUiAmount multiplier (7 of 12 mints carry one, ~1.0009), which
// converts raw 1e8 quote units to exactly one UI share.
//
// Cohort: 12 xStocks with verified Jupiter routes at 1-share impact
// under 2bp (2026-07-13). All mints 8 decimals.

const (
	usdcMint     = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	oneShareRaw  = 100000000 // 1e8 = 1 share at 8 decimals, pre-multiplier
	pollInterval = 60 * time.Second
	httpTimeout  = 15 * time.Second
	quoteGap     = 1100 * time.Millisecond // lite tier: stay well under 60 req/min
	issuerLabel  = "xstocks"
	logThresholdBps = 100.0
)

type Asset struct {
	Symbol string // Yahoo ticker (HOODx maps to HOOD, etc.)
	Mint   string
}

var assets = []Asset{
	{Symbol: "TSLA", Mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"},
	{Symbol: "NVDA", Mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"},
	{Symbol: "AAPL", Mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"},
	{Symbol: "MSFT", Mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX"},
	{Symbol: "AMZN", Mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg"},
	{Symbol: "GOOGL", Mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN"},
	{Symbol: "META", Mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"},
	{Symbol: "HOOD", Mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg"},
	{Symbol: "SPY", Mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"},
	{Symbol: "QQQ", Mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ"},
	{Symbol: "COIN", Mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu"},
	{Symbol: "PLTR", Mint: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4"},
}

func listenAddr() string {
	if v := strings.TrimSpace(os.Getenv("LISTEN_ADDR")); v != "" {
		return v
	}
	return ":2112"
}
