package main

import (
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	takerFeeGauge       *prometheus.GaugeVec
	spreadGauge         *prometheus.GaugeVec
	allInGauge          *prometheus.GaugeVec
	fundingGauge        *prometheus.GaugeVec
	fetchLatencyGauge   *prometheus.GaugeVec
	fetchErrorsCtr      *prometheus.CounterVec
	healthGauge         *prometheus.GaugeVec
	lastRefreshGauge    *prometheus.GaugeVec
)

func init() {
	takerFeeGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_fees_taker_fee_bps",
			Help: "Live taker fee in basis points, read from each venue's public API.",
		},
		[]string{"venue", "chain"},
	)
	prometheus.MustRegister(takerFeeGauge)

	spreadGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_fees_spread_bps",
			Help: "Half-spread + price impact at notional, in basis points.",
		},
		[]string{"venue", "chain"},
	)
	prometheus.MustRegister(spreadGauge)

	allInGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_fees_all_in_bps",
			Help: "All-in opening cost = taker_fee_bps + spread_bps. Lower is cheaper.",
		},
		[]string{"venue", "chain"},
	)
	prometheus.MustRegister(allInGauge)

	fundingGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_fees_funding_rate_per_hour_bps",
			Help: "Current funding rate per hour, in basis points. Positive = longs pay.",
		},
		[]string{"venue", "chain"},
	)
	prometheus.MustRegister(fundingGauge)

	fetchLatencyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_fees_fetch_latency_milliseconds",
			Help: "Wall-clock time of the last successful sample fetch.",
		},
		[]string{"venue", "chain"},
	)
	prometheus.MustRegister(fetchLatencyGauge)

	fetchErrorsCtr = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "perp_fees_fetch_errors_total",
			Help: "Total fetch failures per venue/asset.",
		},
		[]string{"venue", "asset", "error_type"},
	)
	prometheus.MustRegister(fetchErrorsCtr)

	healthGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_fees_health",
			Help: "1 if the most recent sample succeeded, 0 if it errored.",
		},
		[]string{"venue", "chain"},
	)
	prometheus.MustRegister(healthGauge)

	lastRefreshGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_fees_last_refresh_timestamp_seconds",
			Help: "Unix timestamp of the last successful sample.",
		},
		[]string{"venue", "chain"},
	)
	prometheus.MustRegister(lastRefreshGauge)
}

func recordSample(s PerpSample) {
	if s.Err != "" {
		fetchErrorsCtr.WithLabelValues(s.Venue, s.Asset, classifyErr(s.Err)).Inc()
		healthGauge.WithLabelValues(s.Venue, s.Asset).Set(0)
		return
	}
	takerFeeGauge.WithLabelValues(s.Venue, s.Asset).Set(s.TakerFeeBps)
	spreadGauge.WithLabelValues(s.Venue, s.Asset).Set(s.SpreadBps)
	allInGauge.WithLabelValues(s.Venue, s.Asset).Set(s.AllInBps)
	fundingGauge.WithLabelValues(s.Venue, s.Asset).Set(s.FundingRatePerHrBps)
	fetchLatencyGauge.WithLabelValues(s.Venue, s.Asset).Set(float64(s.FetchLatencyMs))
	lastRefreshGauge.WithLabelValues(s.Venue, s.Asset).Set(float64(time.Now().Unix()))
	healthGauge.WithLabelValues(s.Venue, s.Asset).Set(1)
}

func classifyErr(msg string) string {
	switch {
	case contains(msg, "timeout"):
		return "timeout"
	case contains(msg, "401") || contains(msg, "403"):
		return "auth"
	case contains(msg, "429"):
		return "rate_limit"
	case contains(msg, "5"):
		return "server_error"
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
	return s[:n] + "..."
}

// Per-venue×asset debug snapshot — exposed via /debug/perp.
var (
	debugMu        sync.Mutex
	debugSnapshots = map[string]*PerpSample{}
)

func recordDebugSnapshot(s PerpSample) {
	cp := s
	key := s.Venue + "/" + s.Asset
	debugMu.Lock()
	debugSnapshots[key] = &cp
	debugMu.Unlock()
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	setupDebugEndpoint(mux)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("OK")) })
	return http.ListenAndServe(addr, mux)
}
