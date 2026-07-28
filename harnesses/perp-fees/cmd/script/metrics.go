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
	allInTierGauge      *prometheus.GaugeVec
	tierSkippedCtr      *prometheus.CounterVec
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

	// Notional-tier companion series. perp_fees_all_in_bps keeps its
	// exact $1000 meaning (live dashboards + spec queries depend on it);
	// the tiers live under a separate metric so no existing query can
	// match them by accident. The notional="1000" tier duplicates the
	// headline series under the default config.
	allInTierGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "perp_fees_all_in_bps_tier",
			Help: "All-in opening cost at a given notional tier (taker fee + spread + impact), in bps. notional label is the USD trade size.",
		},
		[]string{"venue", "chain", "notional"},
	)
	prometheus.MustRegister(allInTierGauge)

	tierSkippedCtr = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "perp_fees_tier_skipped_total",
			Help: "Tier samples skipped because the fetched orderbook could not fill the tier notional. No extrapolation: thin books show as missing data.",
		},
		[]string{"venue", "chain", "notional"},
	)
	prometheus.MustRegister(tierSkippedCtr)
}

func recordSample(s PerpSample) {
	if s.Err != "" {
		errType := classifyErr(s.Err)
		fetchErrorsCtr.WithLabelValues(s.Venue, s.Asset, errType).Inc()
		healthGauge.WithLabelValues(s.Venue, s.Asset).Set(0)
		// Permanent failures (asset delisted, unsupported venue) must delete
		// the gauge series so stale values don't persist as ghost metrics.
		// Transient failures (timeout, rate limit, server error) intentionally
		// keep the last good value so a brief outage doesn't blank the board.
		if errType == "not_found" {
			allInGauge.DeleteLabelValues(s.Venue, s.Asset)
			spreadGauge.DeleteLabelValues(s.Venue, s.Asset)
			takerFeeGauge.DeleteLabelValues(s.Venue, s.Asset)
			fundingGauge.DeleteLabelValues(s.Venue, s.Asset)
			fetchLatencyGauge.DeleteLabelValues(s.Venue, s.Asset)
			lastRefreshGauge.DeleteLabelValues(s.Venue, s.Asset)
			for _, n := range tierNotionals {
				allInTierGauge.DeleteLabelValues(s.Venue, s.Asset, notionalLabel(n))
			}
		}
		return
	}
	takerFeeGauge.WithLabelValues(s.Venue, s.Asset).Set(s.TakerFeeBps)
	spreadGauge.WithLabelValues(s.Venue, s.Asset).Set(s.SpreadBps)
	allInGauge.WithLabelValues(s.Venue, s.Asset).Set(s.AllInBps)
	fundingGauge.WithLabelValues(s.Venue, s.Asset).Set(s.FundingRatePerHrBps)
	fetchLatencyGauge.WithLabelValues(s.Venue, s.Asset).Set(float64(s.FetchLatencyMs))
	lastRefreshGauge.WithLabelValues(s.Venue, s.Asset).Set(float64(time.Now().Unix()))
	healthGauge.WithLabelValues(s.Venue, s.Asset).Set(1)

	for _, t := range s.Tiers {
		allInTierGauge.WithLabelValues(s.Venue, s.Asset, t.Notional).Set(t.AllInBps)
	}
	// A skipped tier means the fetched book could not fill that notional.
	// Unlike whole-venue failures (where we keep the previous gauge and rely
	// on health/errors), a gauge here would keep republishing a stale spread
	// as if the book were deep enough. Delete the series instead so the
	// tier honestly shows as missing data, and count the skip.
	for _, n := range s.SkippedTiers {
		tierSkippedCtr.WithLabelValues(s.Venue, s.Asset, n).Inc()
		allInTierGauge.DeleteLabelValues(s.Venue, s.Asset, n)
	}
}

func classifyErr(msg string) string {
	switch {
	case contains(msg, "asset_not_found") || contains(msg, "unsupported_venue"):
		return "not_found"
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
