package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds runtime knobs. Set via env vars on Railway.
type Config struct {
	// How often Polymarket gamma-api is polled. 5 min is the conservative
	// default: gamma-api sits behind Cloudflare with a generous global cap
	// (~4000 req/10s) and our paginated /markets pull is ~3 requests per
	// tick. 12 ticks/h * ~3 calls = ~36 req/h, well under any sane ceiling.
	PolymarketRefreshInterval time.Duration

	// Kalshi REST tick. 5 min keeps the cohort numbers fresh; their public
	// /markets endpoint is unauthenticated for read and paginates via a
	// cursor. We paginate until the cursor empties or we hit a safety cap.
	KalshiRefreshInterval time.Duration

	// DefiLlama tick. Slower because the /protocols list moves on daily
	// cadence; 15 min is fine and keeps the courtesy budget low. Used as
	// the canonical fallback aggregate for Limitless and Manifold.
	// Myriad has its own native fetcher (see myriad.go) and is no longer
	// fed from DefiLlama.
	DefillamaRefreshInterval time.Duration

	// Limitless tick. Public api.limitless.exchange does not advertise
	// rate-limit headers and sits behind Cloudflare; 5 min keeps the
	// courtesy budget low. A full walk of /markets/active at page size 25
	// is ~40 pages for the live universe (~1000 markets) with a 200ms
	// inter-page delay, so one tick is bounded under ~10 s. Only fills
	// the cohort gauges the public REST cleanly supports (active count +
	// two lifetime proxies); OI for Limitless still comes from DefiLlama
	// TVL in defillama.go.
	LimitlessRefreshInterval time.Duration

	// Myriad tick. Public api-v2.myriadprotocol.com is rate-limited at
	// 30 req / 10s unauthenticated, silently enforced. One tick spends
	// ~8 paginated requests self-throttled at 1 req/s, so 5 min stays
	// comfortably under budget.
	MyriadRefreshInterval time.Duration

	// Manifold tick. Public api.manifold.markets is generous (500 req/min
	// per IP) and the open universe today (~1.1k markets) fits in 2 pages
	// of 1000, so 5 min is comfortably under budget (~24 req/h).
	ManifoldRefreshInterval time.Duration

	// ManifoldManaUsdRate is the conversion factor applied to Manifold's
	// play-money "mana" balances when publishing the USD-denominated
	// pm_venue_*_usd gauges. There is NO official mana->USD exchange
	// rate: Manifold's CASH sweepstakes token surface is currently empty,
	// so we anchor on the legacy charity-donation rate of 1000 mana = $1
	// (0.001 USD per mana). This is a DISCLOSED convention, not a market
	// price; set MANIFOLD_MANA_USD_RATE to override.
	ManifoldManaUsdRate float64

	// Kalshi authenticated API credentials. The PUBLIC /markets endpoint
	// only surfaces auto-generated derivative tickers with negligible
	// volume, so the 24h gauge stays structurally near zero. With a key
	// pair we instead aggregate the live /markets/trades feed (which
	// carries every fill across the venue including the headline event
	// markets) and scale a 1h sample to 24h. KALSHI_KEY_ID is the public
	// access-key identifier shown in the Kalshi dashboard;
	// KALSHI_PRIVATE_KEY is the PEM-encoded RSA private key Kalshi gave
	// at key-creation time. Both empty = falls back to public-only mode.
	KalshiKeyID      string
	KalshiPrivateKey string
}

func loadConfig() *Config {
	c := &Config{
		PolymarketRefreshInterval: 5 * time.Minute,
		KalshiRefreshInterval:     5 * time.Minute,
		DefillamaRefreshInterval:  15 * time.Minute,
		LimitlessRefreshInterval:  5 * time.Minute,
		MyriadRefreshInterval:     5 * time.Minute,
		ManifoldRefreshInterval:   5 * time.Minute,
		ManifoldManaUsdRate:       0.001,
	}

	if v := os.Getenv("POLYMARKET_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.PolymarketRefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if v := os.Getenv("KALSHI_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.KalshiRefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if v := os.Getenv("DEFILLAMA_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.DefillamaRefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if v := os.Getenv("LIMITLESS_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.LimitlessRefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if v := os.Getenv("MYRIAD_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.MyriadRefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if v := os.Getenv("MANIFOLD_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.ManifoldRefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if v := os.Getenv("MANIFOLD_MANA_USD_RATE"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			c.ManifoldManaUsdRate = f
		}
	}

	c.KalshiKeyID = os.Getenv("KALSHI_KEY_ID")
	c.KalshiPrivateKey = os.Getenv("KALSHI_PRIVATE_KEY")

	fmt.Printf("Config: venues=%d, polymarket_every=%v, kalshi_every=%v, defillama_every=%v, limitless_every=%v, myriad_every=%v, manifold_every=%v, manifold_mana_usd=%v, kalshi_auth=%v\n",
		len(Registry), c.PolymarketRefreshInterval, c.KalshiRefreshInterval, c.DefillamaRefreshInterval,
		c.LimitlessRefreshInterval, c.MyriadRefreshInterval, c.ManifoldRefreshInterval, c.ManifoldManaUsdRate,
		c.KalshiKeyID != "" && c.KalshiPrivateKey != "")
	return c
}
