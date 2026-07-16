package main

import (
	"os"
	"strings"
	"time"
)

// Tokenized-stock-peg harness: onchain price of Robinhood Chain
// tokenized equities (Uniswap v4 pools vs USDG) against the real
// Nasdaq/NYSE price from Yahoo Finance, deviation in basis points,
// labeled by market session state.
//
// Cohort: the 11 official "<Company> • Robinhood Token" equities whose
// USDG pool has real liquidity and swap activity (verified 2026-07-13
// via Blockscout + PoolManager extsload sweep). Excluded and why:
// SPCX (SpaceX is not listed, no reference price exists), SNDK + QQQ
// (pool depth under $2k, pure noise), CRCL (pool has zero liquidity),
// the ~80 other official tokens (issuer-seeded placeholder pools at
// 90-95% fee, zero swaps), HOOD (never issued onchain, only spam).
//
// Orientation: Uniswap v4 orders currencies by address; USDGIsC0 says
// whether USDG (6 decimals) is currency0 in that pool. Stocks are 18
// decimals, so the raw sqrtPriceX96 price converts with a 1e12 factor
// whose direction depends on the ordering.

const (
	rpcDefault      = "https://rpc.mainnet.chain.robinhood.com"
	stateView       = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b"
	getSlot0Sel     = "0xc815641c" // StateView.getSlot0(bytes32) — live-verified
	pollInterval    = 60 * time.Second
	httpTimeout     = 15 * time.Second
	// A tokenized stock more than this far from its reference during
	// regular hours is displayed but flagged; used only for logging.
	logThresholdBps = 100.0
)

type Asset struct {
	Symbol   string // Yahoo ticker == display slug (lowercased for labels)
	Token    string
	PoolID   string
	FeePPM   int
	USDGIsC0 bool
}

// Illiquid tickers dropped 2026-07-16: GOOGL, TSLA, MSFT, AMZN, SPY.
// Their Uniswap v4 pools on Robinhood Chain have no arb activity;
// the pool spot price stays frozen at the last swap value (repeats
// tick after tick) while the Yahoo reference moves normally. Ref
// triggers fire but the pool never converges within the settle
// window, so events roll over as still_open with zero latency
// samples. The 5 dropped names surfaced as "unresponsive" on the
// bench page with no headline number. Cohort restricted to the 6
// tickers with observable arb activity: NVDA, AAPL, PLTR, META,
// AMD, MU. Re-add when a pool's swap volume picks up.
var assets = []Asset{
	{Symbol: "NVDA", Token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", PoolID: "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1", FeePPM: 3000, USDGIsC0: true},
	{Symbol: "AAPL", Token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", PoolID: "0xda4116b5894ee7479e64eae9276e1a2944ef0e5ce863a299d296a15618deee01", FeePPM: 10000, USDGIsC0: true},
	{Symbol: "PLTR", Token: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", PoolID: "0xee430ee1003e1985e1828a01b9a20dad67ad4302994fe2abb4a173de4ac54623", FeePPM: 10000, USDGIsC0: true},
	{Symbol: "META", Token: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", PoolID: "0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36", FeePPM: 3000, USDGIsC0: true},
	{Symbol: "AMD", Token: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", PoolID: "0xde9f85fdd9e05a943a52f2c69ffafe3064a3287df03d02c9b431bc92d4781274", FeePPM: 10000, USDGIsC0: true},
	{Symbol: "MU", Token: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", PoolID: "0x6fa3ee0048e78bf0a513eb0ab56f482944a767c21db990fcf555605e69f05659", FeePPM: 10000, USDGIsC0: true},
}

func rpcURL() string {
	if v := strings.TrimSpace(os.Getenv("TSP_RPC_URL")); v != "" {
		return v
	}
	return rpcDefault
}

func listenAddr() string {
	if v := strings.TrimSpace(os.Getenv("LISTEN_ADDR")); v != "" {
		return v
	}
	return ":2112"
}
