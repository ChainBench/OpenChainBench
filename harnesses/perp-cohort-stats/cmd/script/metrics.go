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
			Help: "Number of perp markets actively trading, per venue. Source: HL native (len(ctxs)), Lighter native (len(orderBookDetails)), Mobula pairs (cross-check). For GMX, derived from DefiLlama protocol breakdown.",
		},
		[]string{"venue"},
	)
	perpVenueMarketsByClass = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_venue_markets_by_class",
			Help: "Number of active markets per venue per asset class (crypto/forex/stocks/indices/commodities). Source: Mobula perp pairs catalog.",
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
		perpVenueHealth, perpVenueFunding24hBps, perpVenueFundingIntervalHours,
		perpVenueLastRefreshUnix,
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
