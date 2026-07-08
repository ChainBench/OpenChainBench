package main

import (
	"os"
	"strings"
	"time"
)

// Source is one (stable, venue, pair) we collect a price from. Every
// source has the same shape (one HTTP GET → one price extraction)
// even though the underlying APIs differ; the per-venue parser lives
// in sources.go.
type Source struct {
	Stable  string // canonical stablecoin slug: usdc, usdt, dai, fdusd, usde
	Venue   string // canonical venue slug: binance, kraken, bitstamp, curve
	Pair    string // venue-specific symbol used in the URL
	Quote   Quote  // what the pair is quoted in (USD-quoted = primary-eligible, USDT-quoted = secondary only)
	URL     string // full URL including the per-pair embedding
	Liquidity float64 // 24h USD volume estimate (used as the median weight at aggregation time)
}

// Quote tags how a price should be interpreted.
//
//   - QuoteUSD     → genuine USD pair (Coinbase USDT-USD, Kraken USDCUSD, Bitstamp).
//     Goes into the primary metric directly.
//   - QuoteUSDT    → USDT-quoted (Binance USDC/USDT).
//     **Excluded from primary** because USDT's own deviation would
//     contaminate every other stable's measurement. Surfaced on a
//     separate `peg_deviation_usdt_anchored` metric.
//   - QuotePool    → on-chain pool spot (Curve get_dy).
//     Counted as primary-eligible for the *output* token; the pool
//     composition is documented in the slug (`curve_3pool_usdc_usdt`).
type Quote string

const (
	QuoteUSD  Quote = "usd"
	QuoteUSDT Quote = "usdt"
	QuotePool Quote = "pool"
)

// pollInterval per venue. Free-tier limits documented in the README;
// cadence picked to stay well within those.
const (
	cexPollInterval   = 5 * time.Second  // Binance/Kraken/Bitstamp REST tickers
	curvePollInterval = 12 * time.Second // matches Ethereum block time
)

// minuteBucketSize is how we group per-venue samples for the
// liquidity-weighted median that feeds the percentile metric.
// 60 s is the spec choice — keeps 1440 samples/day, enough for
// stable p99 estimates.
const minuteBucketSize = 60 * time.Second

// percentileWindow is the rolling window over which we compute the
// p99 deviation. 24 h matches the spec.
const percentileWindow = 24 * time.Hour

// sources returns the source matrix. Order doesn't matter; each
// source runs in its own goroutine.
//
// Liquidity numbers come from the agent-C live validation run (24 h
// $ volume snapshot). They're rough weights, not authoritative — the
// goal is to make a $2.8B Binance pair count more than a $300k Kraken
// pair when both fire in the same minute.
func sources() []Source {
	return []Source{
		// ── USDC ────────────────────────────────────────────────
		{
			Stable: "usdc", Venue: "binance", Pair: "USDCUSDT", Quote: QuoteUSDT,
			URL:       envDefault("STABLE_URL_BINANCE_USDC", "https://api.binance.com/api/v3/ticker/bookTicker?symbol=USDCUSDT"),
			Liquidity: 2_800_000_000,
		},
		{
			Stable: "usdc", Venue: "kraken", Pair: "USDCUSD", Quote: QuoteUSD,
			URL:       envDefault("STABLE_URL_KRAKEN_USDC", "https://api.kraken.com/0/public/Ticker?pair=USDCUSD"),
			Liquidity: 63_000_000,
		},
		{
			Stable: "usdc", Venue: "bitstamp", Pair: "usdcusd", Quote: QuoteUSD,
			URL:       envDefault("STABLE_URL_BITSTAMP_USDC", "https://www.bitstamp.net/api/v2/ticker/usdcusd"),
			Liquidity: 2_600_000,
		},

		// ── USDT ────────────────────────────────────────────────
		// Coinbase + Kraken + Bitstamp are the no-key USD-quoted
		// USDT markets with meaningful depth. Binance USDT is a
		// quote asset, not a tradable pair vs USD.
		{
			Stable: "usdt", Venue: "coinbase", Pair: "USDT-USD", Quote: QuoteUSD,
			URL:       envDefault("STABLE_URL_COINBASE_USDT", "https://api.exchange.coinbase.com/products/USDT-USD/ticker"),
			Liquidity: 25_000_000,
		},
		{
			Stable: "usdt", Venue: "kraken", Pair: "USDTUSD", Quote: QuoteUSD,
			URL:       envDefault("STABLE_URL_KRAKEN_USDT", "https://api.kraken.com/0/public/Ticker?pair=USDTUSD"),
			Liquidity: 184_000_000,
		},
		{
			Stable: "usdt", Venue: "bitstamp", Pair: "usdtusd", Quote: QuoteUSD,
			URL:       envDefault("STABLE_URL_BITSTAMP_USDT", "https://www.bitstamp.net/api/v2/ticker/usdtusd"),
			Liquidity: 12_500_000,
		},

		// ── FDUSD ───────────────────────────────────────────────
		// Binance is the only no-key venue with depth on FDUSD
		// (~$41M/24h). The price is USDT-anchored, so it's only
		// in the secondary metric — fine, because FDUSD's main
		// risk story is its FDUSDUSDT deviation specifically.
		{
			Stable: "fdusd", Venue: "binance", Pair: "FDUSDUSDT", Quote: QuoteUSDT,
			URL:       envDefault("STABLE_URL_BINANCE_FDUSD", "https://api.binance.com/api/v3/ticker/bookTicker?symbol=FDUSDUSDT"),
			Liquidity: 41_000_000,
		},

		// ── USDe (Ethena) ───────────────────────────────────────
		// Binance is the venue that flashed to $0.65 on Oct 10
		// 2025. Thin volume normally but the most-watched book.
		{
			Stable: "usde", Venue: "binance", Pair: "USDEUSDT", Quote: QuoteUSDT,
			URL:       envDefault("STABLE_URL_BINANCE_USDE", "https://api.binance.com/api/v3/ticker/bookTicker?symbol=USDEUSDT"),
			Liquidity: 1_800_000,
		},

		// ── DAI ─────────────────────────────────────────────────
		// CEX coverage for DAI is essentially dead in 2026
		// (re-validated 2026-07-08: Kraken DAIUSD ~$145k/24h with
		// a ~9 bps spread, Bitstamp daiusd zero volume, Coinbase
		// DAI-USD delisted). The only honest signal is on-chain
		// via Curve 3pool. We don't include thin CEX DAI pairs to
		// avoid the thin-market noise contaminating the metric.
		//
		// The published price is the geometric mean of get_dy in
		// both directions (see pollCurve3poolMid), which cancels
		// the pool swap fee so the series is comparable to the
		// CEX mid prices used for USDC/USDT.
		{
			Stable: "dai", Venue: "curve_3pool", Pair: "usdc<->dai mid", Quote: QuotePool,
			URL:       envDefault("STABLE_URL_CURVE_RPC", "https://ethereum-rpc.publicnode.com"),
			Liquidity: 500_000_000, // 3pool TVL, approximate
		},
	}
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
