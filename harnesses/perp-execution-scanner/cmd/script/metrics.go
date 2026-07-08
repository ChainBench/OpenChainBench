package main

import (
	"net/http"
	"strconv"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Every metric label set here is part of the OCB benchmark spec contract.
// Renaming or dropping a label breaks the citable API and every consumer
// SPARQL/PromQL query on the bench page; dual-publish before any cutover.
//
//   perp_execution_slippage_bps{asset, venue, side, size_usd}   gauge
//   perp_execution_spread_bps{asset, venue}                     gauge
//   perp_execution_top_bid_usd{asset, venue}                    gauge
//   perp_execution_top_ask_usd{asset, venue}                    gauge
//   perp_execution_max_fillable_usd{asset, venue, side}         gauge
//   perp_execution_health{asset, venue}                         gauge (0|1)
//   perp_execution_last_scrape_ts{asset, venue}                 gauge (unix)
//   perp_execution_fetch_latency_ms{asset, venue}               gauge
//   perp_execution_fetch_errors_total{asset, venue, error_type} counter
var (
	slippageGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_execution_slippage_bps",
			Help: "Effective slippage in basis points vs top-of-book mid, walked on the live orderbook for a given USD notional per side.",
		},
		[]string{"asset", "venue", "side", "size_usd"},
	)
	spreadGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_execution_spread_bps",
			Help: "Top-of-book bid/ask spread in basis points, (best_ask-best_bid)/mid.",
		},
		[]string{"asset", "venue"},
	)
	topBidGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_execution_top_bid_usd",
			Help: "Best bid price in USD.",
		},
		[]string{"asset", "venue"},
	)
	topAskGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_execution_top_ask_usd",
			Help: "Best ask price in USD.",
		},
		[]string{"asset", "venue"},
	)
	maxFillableGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_execution_max_fillable_usd",
			Help: "Maximum USD notional fillable by walking the visible book on the given side.",
		},
		[]string{"asset", "venue", "side"},
	)
	healthGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_execution_health",
			Help: "1 when the last scrape succeeded and produced a two-sided book, 0 otherwise.",
		},
		[]string{"asset", "venue"},
	)
	lastScrapeGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_execution_last_scrape_ts",
			Help: "Unix timestamp of the last successful orderbook scrape.",
		},
		[]string{"asset", "venue"},
	)
	fetchLatencyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_execution_fetch_latency_ms",
			Help: "Wall-clock time of the last successful book fetch, in milliseconds.",
		},
		[]string{"asset", "venue"},
	)
	fetchErrorsCtr = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "perp_execution_fetch_errors_total",
			Help: "Total fetch failures per (asset, venue, error_type).",
		},
		[]string{"asset", "venue", "error_type"},
	)
	lastTickGauge = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "perp_execution_last_tick_unix",
			Help: "Unix timestamp of the last harness sweep; liveness probe.",
		},
	)
)

func init() {
	prometheus.MustRegister(
		slippageGauge, spreadGauge, topBidGauge, topAskGauge,
		maxFillableGauge, healthGauge, lastScrapeGauge,
		fetchLatencyGauge, fetchErrorsCtr, lastTickGauge,
	)
}

// sizeLabel renders a bucket into the canonical Prom label used across
// the bench spec ("100", "1000", "10000", ...). Kept as a helper so the
// harness and the YAML methodology stay literally byte-for-byte aligned.
func sizeLabel(size float64) string {
	return strconv.FormatFloat(size, 'f', -1, 64)
}

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
	case contains(msg, "parse"), contains(msg, "bad_shape"):
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
