package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// All gauges below are read by the OCB UI side via the exact Prom
// selectors documented in the perp-cohort-stats spec. Renaming any of
// these breaks the contract; if a metric needs to evolve, add a new
// gauge and dual-publish until the UI cut-over lands.
//
// Naming convention is `perp_venue_<metric>` for per-venue cohort
// gauges; observability gauges/counters live under
// `perp_cohort_stats_*`.
var (
	// Cohort gauges ====================================================
	perpVenueVolume24hUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_volume_24h_usd",
			Help: "Notional traded volume in USD over the last 24h, per perp venue. Source: HL native (sum dayNtlVlm), Lighter native (total_quote_token_volume_24h), DefiLlama HTML perpVolume.total24h.",
		},
		[]string{"venue"},
	)
	perpVenueVolume30dUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_volume_30d_usd",
			Help: "Notional traded volume in USD over the last 30d, per perp venue. Source: DefiLlama HTML perpVolume.total30d (no native equivalent on HL/Lighter info endpoints).",
		},
		[]string{"venue"},
	)
	perpVenueOIUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_oi_usd",
			Help: "Current open interest in USD, per perp venue. Source: HL native (sum openInterest*markPx), Lighter native (sum open_interest across orderBookDetails markets), DefiLlama HTML openInterest.total24h.",
		},
		[]string{"venue"},
	)
	perpVenueFees30dUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_fees_30d_usd",
			Help: "Total protocol fees in USD over the last 30d, per perp venue. Source: DefiLlama HTML fees.total30d (DefiLlama is the canonical aggregator across perp DEXes).",
		},
		[]string{"venue"},
	)
	perpVenueActiveMarkets = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_active_markets",
			Help: "Number of perp markets actively trading, per venue. Source: HL native (len(ctxs)), Lighter native (len(orderBookDetails)), Gains trading variables minus delisted pairs. For GMX, derived from DefiLlama protocol breakdown.",
		},
		[]string{"venue"},
	)
	perpVenueMarketsByClass = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_markets_by_class",
			Help: "Number of active markets per venue per asset class (crypto/forex/stocks/indices/commodities). Source: each venue's native catalog and asset tags, or the cross-venue symbol classification for venues without tags (breadth.go).",
		},
		[]string{"venue", "class"},
	)
	perpVenueNoncoreMarketsTotal = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_noncore_markets_total",
			Help: "Total non-crypto markets (forex+stocks+indices+commodities) per venue. Higher = more asset class breadth beyond crypto.",
		},
		[]string{"venue"},
	)
	perpVenueTopMarketVolume24hUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_top_market_volume_24h_usd",
			Help: "Highest single-market 24h volume in USD, per perp venue. Source: HL native (max dayNtlVlm), Lighter native (max daily_quote_token_volume).",
		},
		[]string{"venue"},
	)
	perpVenueTvlUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_tvl_usd",
			Help: "Total value locked in USD per perp venue, excluding staking and pool2 categories. Source: DefiLlama /protocol/{slug} currentChainTvls.",
		},
		[]string{"venue"},
	)
	// High-leverage terms ==============================================
	// Governance parameters rather than sampled measurements, read fresh
	// each tick. Keyed by market as well as venue because the comparison
	// only means anything on the same asset, and the only assets two
	// high-leverage venues both list are BTC and ETH.
	//
	// Two label names here are the site's, not ours. The site injects a
	// fixed set of dimension labels into a bench's queries (chain, region,
	// kind, venue, bucket, amount_usd, tier), so the market rides in `kind`
	// and the leverage setting in `bucket`. Naming them `market` and
	// `leverage` would mean teaching the spec schema two new dimensions for
	// one bench, and a dimension the site cannot inject leaves every
	// selector matching many series, which renders as an empty page with no
	// error anywhere.
	//
	// `bucket="all"` is the venue's OWN maximum, not a pooled series. The
	// site replaces a selector pinned to "all" with the chosen value, so the
	// spec pins bucket="all" and the unfiltered page reads as the
	// max-leverage view while every other tab is a setting shared across
	// venues.
	perpLeverageMax = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_leverage_max",
			Help: "Maximum leverage a venue allows on a market, repeated at every bucket so the column reads the same on each leverage tab. Source: Gains pairMaxLeverage on the Arbitrum diamond, Papertrade /state/trading instrument tuple.",
		},
		[]string{"venue", "kind", "bucket"},
	)
	perpLiqPriceMovePct = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_liq_price_move_pct",
			Help: "Adverse price move, in percent, that liquidates a position opened at the leverage in `bucket` (`all` = the venue maximum), measured at open and excluding carry. Computed as 1/leverage minus the venue maintenance requirement as a share of notional. Gains: liquidation threshold divided by leverage. Papertrade: the bust buffer, which is already a share of price and does not vary with leverage.",
		},
		[]string{"venue", "kind", "bucket"},
	)
	perpLiqCollateralLostPct = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_liq_collateral_lost_pct",
			Help: "Share of the collateral, in percent, already lost when the position is liquidated at the leverage in `bucket`. The same measurement as perp_liq_price_move_pct in the unit venues quote among themselves: room times leverage.",
		},
		[]string{"venue", "kind", "bucket"},
	)
	perpLiqCollateralKeptPct = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_liq_collateral_kept_pct",
			Help: "Share of collateral, in percent, returned to the trader when a position opened at the leverage in `bucket` is liquidated. Maintenance requirement times leverage. Gains: 100 minus the liquidation threshold. Papertrade: zero, crossing the bust price forfeits the whole margin.",
		},
		[]string{"venue", "kind", "bucket"},
	)
	perpVenueHealth = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_health",
			Help: "Composite health score [0..1] per venue. 1 = all primary sources healthy, fractional = some sources failed but carry-forward kept gauges populated, 0 = total miss.",
		},
		[]string{"venue"},
	)
	perpVenueFunding24hBps = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_funding_24h_bps",
			Help: "Funding rate per venue per asset, normalized to a 24h figure in basis points. Source: Mobula /market/cefi/funding-rate. Formula: fundingRate * (24h_ms / epochDurationMs) * 10000.",
		},
		[]string{"venue", "asset"},
	)
	perpVenueFundingIntervalHours = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_funding_interval_hours",
			Help: "Funding interval in hours per venue per asset. Source: Mobula /market/cefi/funding-rate epochDurationMs / 3600000.",
		},
		[]string{"venue", "asset"},
	)
	perpVenueFundingRefreshUnix = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_funding_refresh_unix",
			Help: "Unix timestamp of the last tick on which a source produced a funding rate for the (venue, asset). Neither the carry-forward nor the reaper touches it, so a funding bench's success check reads the rate's own freshness on its own asset (a stale stamp stays exported as stale), not the venue's volume feed or another asset's rate.",
		},
		[]string{"venue", "asset"},
	)
	perpVenueLastRefreshUnix = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_last_refresh_unix",
			Help: "Unix timestamp of the last successful refresh for a (venue, source) pair. On total-miss ticks the carry-forward keeps the gauge value but does NOT advance this timestamp, so the UI can compute true data age.",
		},
		[]string{"venue", "source"},
	)

	// Observability ====================================================
	perpCohortFetchErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "perp_cohort_stats_fetch_errors_total",
			Help: "Total number of fetch failures per (venue, source, error_type). error_type is the bounded classifyError() bucket.",
		},
		[]string{"venue", "source", "error_type"},
	)
	perpCohortSourceUsed = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_cohort_stats_source_used",
			Help: "Set to 1 when the named source served the latest value for the (venue, metric). Resets each tick so a venue×metric has exactly one 1 across the source label.",
		},
		[]string{"venue", "metric", "source"},
	)
	perpCohortDataDivergence = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "perp_cohort_stats_data_divergence_total",
			Help: "Incremented when two sources disagree by more than 10 percent (|a-b|/max(a,b) > 0.10) for the same (venue, metric).",
		},
		[]string{"venue", "metric"},
	)
	perpCohortLastTickUnix = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "perp_cohort_stats_last_tick_unix",
			Help: "Unix timestamp of the last harness sweep. Liveness probe.",
		},
	)
)

func init() {
	prometheus.MustRegister(
		perpVenueVolume24hUsd, perpVenueVolume30dUsd, perpVenueOIUsd,
		perpVenueFees30dUsd, perpVenueActiveMarkets, perpVenueTopMarketVolume24hUsd,
		perpVenueMarketsByClass, perpVenueNoncoreMarketsTotal,
		perpVenueTvlUsd,
		perpLeverageMax, perpLiqPriceMovePct, perpLiqCollateralLostPct, perpLiqCollateralKeptPct,
		perpVenueHealth, perpVenueFunding24hBps, perpVenueFundingIntervalHours,
		perpVenueFundingRefreshUnix, perpVenueLastRefreshUnix,
		perpCohortFetchErrors, perpCohortSourceUsed, perpCohortDataDivergence,
		perpCohortLastTickUnix,
	)
}

// classifyError buckets an error message into a small finite enum so
// the fetch-errors counter stays bounded in cardinality. Mirrors the
// pm-cohort-stats classifier so OCB dashboards can reuse one template.
func classifyError(msg string) string {
	switch {
	case contains(msg, "timeout"), contains(msg, "deadline"):
		return "timeout"
	case contains(msg, "401"), contains(msg, "403"), contains(msg, "unauthorized"):
		return "auth"
	case contains(msg, "429"):
		return "rate_limit"
	case contains(msg, "500"), contains(msg, "502"), contains(msg, "503"), contains(msg, "504"):
		return "server_error"
	case contains(msg, "404"):
		return "not_found"
	case contains(msg, "not_tracked"), contains(msg, "empty_series"), contains(msg, "unavailable"):
		return "not_tracked"
	case contains(msg, "parse"):
		return "parse"
	default:
		return "other"
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// truncate caps a string at n bytes; used to keep error messages compact
// when they get echoed into Prom error counters via classifyError.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("OK")) })
	mux.Handle("/logs", logsHandler())
	return http.ListenAndServe(addr, mux)
}
