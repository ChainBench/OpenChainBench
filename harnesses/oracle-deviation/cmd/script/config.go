package main

import (
	"os"
	"strings"
	"time"
)

// Pair is the canonical OCB symbol used as the `pair` Prometheus
// label. We always normalize to <BASE>/USD even though Binance only
// quotes USDT and Coinbase quotes USD — the comparison treats USDT
// as ≈ USD ± 0.1% (documented caveat, see README).
type Pair string

// Source is the oracle slug used as the `source` Prometheus label.
// Match the OCB provider-registry convention (lowercase, no slashes).
type Source string

const (
	SourceChainlink Source = "chainlink"
	SourcePyth      Source = "pyth"
	SourceBinance   Source = "binance"
	SourceCoinbase  Source = "coinbase"
)

// pollInterval is the shared scrape cadence per source × pair. 30 s
// keeps us comfortably under every free-tier rate limit (Pyth ~30/s
// soft, Binance 1200/min, Coinbase 10/s public, RPC public no hard
// cap but courteous) — 4 sources × 10 pairs × 2/min = 80 req/min
// total, with bursts spread over 30 s windows.
const pollInterval = 30 * time.Second

// httpTimeout is the per-request ceiling for every HTTP / RPC call.
// 8 s matches the gas-estimation harness and is more than enough for
// any of the four upstreams when healthy.
const httpTimeout = 8 * time.Second

// PairSpec wires one canonical pair to its per-source identifier.
// Filling all four fields is mandatory; an empty field is treated as
// "not supported" by the poller and the metric simply won't appear.
type PairSpec struct {
	Pair             Pair
	ChainlinkFeed    string // Ethereum mainnet AggregatorV3 contract
	PythID           string // hex feed id with 0x prefix
	BinanceSymbol    string // e.g. BTCUSDT
	CoinbaseProduct  string // e.g. BTC-USD
}

// pairs returns the 10-pair matrix. The MATIC entry uses Pyth's POL
// feed (Pyth renamed the symbol on 2024-09-04 when Polygon migrated;
// the on-chain Chainlink feed is still called MATIC/USD on mainnet).
func pairs() []PairSpec {
	return []PairSpec{
		{"BTC/USD", "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", "BTCUSDT", "BTC-USD"},
		{"ETH/USD", "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", "ETHUSDT", "ETH-USD"},
		{"SOL/USD", "0x4ffC43a60e009B551865A93d232E33Fce9f01507", "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "SOLUSDT", "SOL-USD"},
		{"BNB/USD", "0x14e613AC84a31f709eadbdF89C6CC390fDc9540A", "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f", "BNBUSDT", "BNB-USD"},
		// XRP/ADA/DOGE: Chainlink retired the Ethereum mainnet
		// AggregatorV3 contracts for these three pairs. eth_call
		// against the previously-published proxies (0xCed266..., 0xAE48c9...,
		// 0x2465Ce...) now reverts in 100% of cases, which spammed
		// ocb_oracle_scrape_errors_total at ~2.9 k errors / pair / day.
		// Pyth / Binance / Coinbase still publish these symbols, so we
		// keep the pair with an empty ChainlinkFeed — the poller treats
		// empty addresses as "no Chainlink source for this pair", skips
		// the RPC round-trip and produces no error. Restore the address
		// the day Chainlink re-publishes mainnet feeds for these pairs.
		{"XRP/USD", "", "0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8", "XRPUSDT", "XRP-USD"},
		{"ADA/USD", "", "0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d", "ADAUSDT", "ADA-USD"},
		{"DOGE/USD", "", "0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c", "DOGEUSDT", "DOGE-USD"},
		{"AVAX/USD", "0xFF3EEb22B5E3dE6e705b44749C2559d704923FD7", "0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7", "AVAXUSDT", "AVAX-USD"},
		{"LINK/USD", "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c", "0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221", "LINKUSDT", "LINK-USD"},
		// MATIC: Polygon migrated MATIC → POL 1:1 in Sep 2024. The
		// Chainlink mainnet feed contract is still named MATIC/USD
		// but tracks the POL token (verified against on-chain
		// `description()` and the price level matches Pyth/Coinbase).
		// Pyth renamed the feed to POL/USD; Coinbase delisted
		// MATIC-USD and only lists POL-USD; Binance kept the old
		// MATICUSDT pair (deprecated, ~4x detached from spot) AND
		// listed POLUSDT — we point Binance at POLUSDT so all four
		// sources track the same underlying asset.
		{"MATIC/USD", "0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676", "0xffd11c5a1cfd42f80afb2df4d9f264c15f956d68153335374ec10722edd70472", "POLUSDT", "POL-USD"},
	}
}

// ChainFeed wires one Chainlink AggregatorV3 deployment on a non-
// Ethereum chain to the freshness tracker (bench № 082). These feeds
// are freshness-only: they never enter the 025 deviation store (the
// price store is keyed by (pair, source), so an Arbitrum ETH/USD
// sample would silently overwrite the Ethereum one and change 025's
// deviation numbers).
type ChainFeed struct {
	Pair  Pair
	Chain string // freshness `chain` label: arbitrum | base
	Feed  string // AggregatorV3 contract on that chain
	RPCs  []string
}

// extraChainlinkFeeds lists the non-Ethereum Chainlink deployments the
// freshness bench tracks. Ethereum mainnet feeds are covered by the
// existing 025 poller (which now also feeds recordFreshness).
func extraChainlinkFeeds() []ChainFeed {
	return []ChainFeed{
		{
			Pair:  "ETH/USD",
			Chain: ChainArbitrum,
			Feed:  "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
			RPCs: []string{
				envDefault("ORACLE_RPC_ARBITRUM", "https://arbitrum-one-rpc.publicnode.com"),
				"https://arb1.arbitrum.io/rpc",
			},
		},
		{
			Pair:  "ETH/USD",
			Chain: ChainBase,
			Feed:  "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
			RPCs: []string{
				envDefault("ORACLE_RPC_BASE", "https://base-rpc.publicnode.com"),
				"https://mainnet.base.org",
			},
		},
	}
}

// RedstoneFeed maps a canonical OCB pair to RedStone's symbol on the
// public per-symbol price API.
type RedstoneFeed struct {
	Pair   Pair
	Symbol string
}

// redstoneFeeds is the freshness cohort for RedStone. ETH + BTC only
// in v1: the per-symbol endpoint costs one request per symbol per
// tick, and the bench's headline is ETH/USD.
func redstoneFeeds() []RedstoneFeed {
	return []RedstoneFeed{
		{Pair: "ETH/USD", Symbol: "ETH"},
		{Pair: "BTC/USD", Symbol: "BTC"},
	}
}

// redstoneBaseURL is RedStone's public per-symbol price API. The
// data-packages gateway payload for the whole redstone-primary-prod
// service is ~1.7 MB per request; the per-symbol endpoint returns a
// single small object with the signed package's value + timestamp,
// so we poll per symbol instead.
func redstoneBaseURL() string {
	return envDefault("ORACLE_REDSTONE_URL", "https://api.redstone.finance/prices")
}

// rpcEndpoint is the Ethereum mainnet public RPC used by the
// Chainlink poller to call latestRoundData() on the AggregatorV3
// contracts. Two free public endpoints are kept; the second is a
// fallback the chainlink poller rotates to on consecutive errors.
func rpcEndpoint() string {
	return envDefault("ORACLE_RPC_PRIMARY", "https://ethereum-rpc.publicnode.com")
}

func rpcEndpointFallback() string {
	return envDefault("ORACLE_RPC_FALLBACK", "https://eth.llamarpc.com")
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
