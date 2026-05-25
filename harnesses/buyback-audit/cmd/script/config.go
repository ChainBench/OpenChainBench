package main

import (
	"os"
	"time"
)

// Window represents a rolling lookback window used by the audit.
type Window struct {
	Name string
	Dur  time.Duration
}

// Protocol bundles every static fact we need to scrape one buyback program.
type Protocol struct {
	Slug         string  // metric label
	Treasury     string  // on-chain address holding / executing buybacks
	ChainID      int     // for Etherscan v2 (0 if N/A — e.g. Hyperliquid native)
	TokenAddr    string  // ERC20 contract whose INFLOWS to Treasury count as executed
	                     // buyback (e.g. SKY for the Sky SBE). Empty = use native ETH outflows.
	TokenDec     int     // decimals for TokenAddr (18 default, but kept explicit)
	BuybackShare float64 // fee_share that the protocol promised to spend on buybacks
	LlamaSlug    string  // DeFiLlama fees endpoint slug
	PriceID      string  // CoinGecko id for the bought-back token (for executed_usd)
	Native       string  // human label of bought-back token
}

// All windows we report on. The leaderboard YAML only consumes 7d and 30d;
// extending here is harmless because the gauge carries a `window` label.
var windows = []Window{
	{Name: "7d", Dur: 7 * 24 * time.Hour},
	{Name: "30d", Dur: 30 * 24 * time.Hour},
}

// Static protocol roster. Addresses are the ones validated by the
// feasibility study; swapping a slug here propagates everywhere.
var protocols = []Protocol{
	{
		Slug:         "hyperliquid",
		Treasury:     "0xfefefefefefefefefefefefefefefefefefefefe", // Assistance Fund
		ChainID:      0,                                            // not an EVM scan
		BuybackShare: 0.97,
		LlamaSlug:    "hyperliquid",
		PriceID:      "hyperliquid",
		Native:       "HYPE",
	},
	// GMX is intentionally excluded from v1. The protocol does not run
	// an on-market GMX buyback program the way Hyperliquid AF or Sky SBE
	// do — V2 fees flow to GLP / GM pool LPs in ETH/stables and to GMX
	// stakers via esGMX reward distributors, with no single "buyback
	// wallet" whose outflows we can audit. The original treasury address
	// 0x68863dDE…dea6A has been dormant since 2022-08 (verified via
	// Etherscan v2). v2 of this bench will add Jupiter Litterbox Trust
	// (50 % fees → JUP buyback on Solana) and Aave AFC as cleaner
	// replacements once their executor addresses are confirmed.
	{
		Slug:      "sky",
		Treasury:  "0xBE8E3e3618f7474F8cB1d074A26afFef007E98FB", // SBE receiver
		ChainID:   1,
		TokenAddr: "0x56072C95FAA701256059aa122697B133aDEd9279", // SKY ERC20
		TokenDec:  18,
		// SBE is deterministic — over a window the executed amount equals
		// SKY tokens received by the SBE address (bought from Uniswap with
		// protocol surplus). The "promise" is modelled as 100% of fees
		// because the engine is supposed to consume the entire surplus
		// stream; a sustained ratio < 1 means buffer accumulation or
		// surplus pull-throttling is happening.
		BuybackShare: 1.00,
		LlamaSlug:    "makerdao",
		PriceID:      "sky",
		Native:       "SKY",
	},
}

// Etherscan v2 single-key, multi-chain endpoint.
const etherscanV2Endpoint = "https://api.etherscan.io/v2/api"

// scrapeInterval is per-protocol. 5 min is plenty for 7d / 30d gauges.
const scrapeInterval = 5 * time.Minute

// HTTP timeout for any single upstream call.
const httpTimeout = 20 * time.Second

// etherscanAPIKey returns the user-supplied key or "" — callers must
// handle the missing-key path gracefully (log a warning, emit 0).
func etherscanAPIKey() string {
	return os.Getenv("ETHERSCAN_API_KEY")
}
