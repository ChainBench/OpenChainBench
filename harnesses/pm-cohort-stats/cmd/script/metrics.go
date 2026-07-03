package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// All gauges are keyed by `venue=<OCB slug>`. The site reads them with
// the exact same selector via the PM cohort fetcher. Naming convention
// is `pm_venue_<metric>` so a reader can tell at a glance that the value
// comes from the cohort-stats harness; the producing source is recorded
// alongside in the observability counters, not in the gauge name.
var (
	// Cohort gauges =====================================================
	pmVenueVolume30dUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_volume_30d_usd",
			Help: "Notional traded volume in USD, rolling 30 days, per venue. Source: Polymarket gamma /markets volume1mo, Kalshi /markets volume aggregated (proxy), Myriad /markets sum(volume) over rows with publishedAt > now-30d (APPROXIMATION: counts lifetime volume of markets first published in the last 30d, not a true rolling sum), DefiLlama /protocols 30d fallback. For Manifold (play-money), this is the mana-denominated figure scaled by MANIFOLD_MANA_USD_RATE (default 0.001 = legacy charity donation rate, NOT a market exchange rate); see pm_venue_volume_30d_mana for the raw value.",
		},
		[]string{"venue"},
	)
	pmVenueVolume24hUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_volume_24h_usd",
			Help: "Notional traded volume in USD over the last 24h, per venue. Source: Polymarket gamma /markets volume24hr, Kalshi /markets recent activity, Myriad /markets sum(volumeNotional24h) across open + just-resolved USD-stable markets, DefiLlama /protocols 24h fallback. For Manifold (play-money), this is the mana-denominated figure scaled by MANIFOLD_MANA_USD_RATE (default 0.001 = legacy charity donation rate, NOT a market exchange rate); see pm_venue_volume_24h_mana for the raw value.",
		},
		[]string{"venue"},
	)
	pmVenueOpenInterestUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_open_interest_usd",
			Help: "Current open interest in USD, per venue. Source: Polymarket gamma /markets openInterest sum, Kalshi /markets open_interest sum scaled by last_price, Myriad /markets sum(liquidity * liquidityPrice) across USD-stable open markets (replaces the prior DefiLlama TVL proxy). For Manifold (play-money), this is the sum of totalLiquidity (AMM seed, mana) scaled by MANIFOLD_MANA_USD_RATE (default 0.001 = legacy charity donation rate, NOT a market exchange rate); see pm_venue_open_interest_mana for the raw value.",
		},
		[]string{"venue"},
	)
	pmVenueActiveMarkets = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_active_markets",
			Help: "Number of markets open right now, per venue. Source: count of /markets rows with status=open / active=true and not closed.",
		},
		[]string{"venue"},
	)
	pmVenueTopMarketVolume24hUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_top_market_volume_24h_usd",
			Help: "Highest single-market 24h volume in USD, per venue. Source: max(volume24hr) across active markets. For Limitless this is a lifetime proxy - the public REST does not expose a 24h aggregate field. For Manifold (play-money), this is the mana-denominated figure scaled by MANIFOLD_MANA_USD_RATE (default 0.001 = legacy charity donation rate, NOT a market exchange rate); see pm_venue_top_market_volume_24h_mana for the raw value.",
		},
		[]string{"venue"},
	)
	pmVenueMarketsAbove1m = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_markets_above_1m",
			Help: "Number of markets that have crossed $1m all-time traded volume, per venue. Source: count of /markets rows with volume >= 1_000_000. For Limitless this is a lifetime proxy - the public REST does not expose a 24h aggregate field. For Manifold (play-money), the threshold is 1_000_000_000 mana ($1M at the default 0.001 charity rate); see pm_venue_markets_above_1b_mana for the raw mana-side counter.",
		},
		[]string{"venue"},
	)

	// Manifold mana-denominated gauges ===================================
	// Manifold is play-money: the unit is mana, with no official mana->USD
	// market exchange rate. We expose a parallel mana-denominated gauge
	// family alongside the existing pm_venue_*_usd gauges so dashboards
	// can render the raw value and the conversion side by side.
	pmVenueVolume30dMana = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_volume_30d_mana",
			Help: "Manifold play-money raw value (mana), 30d projection from 24h * 30; pm_venue_volume_30d_usd is the same scaled by MANIFOLD_MANA_USD_RATE (default 0.001 from the legacy charity donation rate, NOT a market exchange rate).",
		},
		[]string{"venue"},
	)
	pmVenueVolume24hMana = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_volume_24h_mana",
			Help: "Manifold play-money raw value (mana); pm_venue_volume_24h_usd is the same scaled by MANIFOLD_MANA_USD_RATE (default 0.001 from the legacy charity donation rate, NOT a market exchange rate).",
		},
		[]string{"venue"},
	)
	pmVenueOpenInterestMana = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_open_interest_mana",
			Help: "Manifold play-money raw value (mana), sum of totalLiquidity across open markets used as the OI proxy; pm_venue_open_interest_usd is the same scaled by MANIFOLD_MANA_USD_RATE (default 0.001 from the legacy charity donation rate, NOT a market exchange rate).",
		},
		[]string{"venue"},
	)
	pmVenueTopMarketVolume24hMana = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_top_market_volume_24h_mana",
			Help: "Manifold play-money raw value (mana), highest single-market 24h volume; pm_venue_top_market_volume_24h_usd is the same scaled by MANIFOLD_MANA_USD_RATE (default 0.001 from the legacy charity donation rate, NOT a market exchange rate).",
		},
		[]string{"venue"},
	)
	pmVenueMarketsAbove1bMana = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_venue_markets_above_1b_mana",
			Help: "Manifold play-money mana-side counter: number of markets with lifetime volume >= 1_000_000_000 mana (= $1M at the 0.001 charity rate). Mirror of pm_venue_markets_above_1m for the play-money side.",
		},
		[]string{"venue"},
	)

	// Observability =====================================================
	pmCohortStatsLastRefresh = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_cohort_stats_last_refresh_timestamp_seconds",
			Help: "Unix timestamp of the last successful refresh per venue per source.",
		},
		[]string{"venue", "source"},
	)
	pmCohortStatsFetchLatencyMs = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_cohort_stats_fetch_latency_milliseconds",
			Help: "Wall-clock fetch latency per venue per source.",
		},
		[]string{"venue", "source"},
	)
	pmCohortStatsFetchErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "pm_cohort_stats_fetch_errors_total",
			Help: "Total number of fetch failures per venue per source, by error type.",
		},
		[]string{"venue", "source", "error_type"},
	)
	pmCohortStatsLastTickUnix = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "pm_cohort_stats_last_tick_unix",
			Help: "Unix timestamp of the last harness tick (any source). Liveness probe for the cron alerter.",
		},
	)
)

func init() {
	prometheus.MustRegister(
		pmVenueVolume30dUsd, pmVenueVolume24hUsd, pmVenueOpenInterestUsd,
		pmVenueActiveMarkets, pmVenueTopMarketVolume24hUsd, pmVenueMarketsAbove1m,
		pmVenueVolume30dMana, pmVenueVolume24hMana, pmVenueOpenInterestMana,
		pmVenueTopMarketVolume24hMana, pmVenueMarketsAbove1bMana,
		pmCohortStatsLastRefresh, pmCohortStatsFetchLatencyMs, pmCohortStatsFetchErrors,
		pmCohortStatsLastTickUnix,
	)
}

// classifyError buckets a fetch error string into a small finite enum so
// pm_cohort_stats_fetch_errors_total stays bounded in cardinality. Same
// shape as chain-kpis' classifier (timeout, auth, rate_limit, server,
// other) so the OCB dashboards can reuse one template across harnesses.
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
	case contains(msg, "not_tracked"), contains(msg, "empty_series"):
		// Expected: the upstream confirmed the venue is supported but has
		// no data for this cohort metric yet. Keep it out of "other" so
		// dashboards do not false-positive.
		return "not_tracked"
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

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("OK")) })
	return http.ListenAndServe(addr, mux)
}
