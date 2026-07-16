package main

import (
	"net/http"
	"os"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the ws-head-latency harness. Names follow the
// `<bench>_<measurement>_<unit>` OCB convention. Series carry
// {provider, chain} plus a static {region} ConstLabel bound at
// process startup, so a multi-region deploy (Railway replicas or
// VPS + Railway hybrid) never collides series across vantage points
// and no observation site needs to know about the region.
//
// Region resolution order at startup: REGION (matches the convention
// used by rpc-capabilities and every other multi-region harness on
// Railway), then RAILWAY_REPLICA_REGION (Railway auto-sets it), then
// the eu-west default that matches the historical single-vantage
// Paris VPS deployment. Set REGION explicitly on each replica to
// guarantee a stable value across redeploys.
var region = resolveRegion()

func resolveRegion() string {
	if r := os.Getenv("REGION"); r != "" {
		return r
	}
	if r := os.Getenv("RAILWAY_REPLICA_REGION"); r != "" {
		return r
	}
	return "eu-west"
}

var regionLabels = prometheus.Labels{"region": region}

var (
	headLagHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "ws_head_lag_milliseconds",
			Help: "Per-block push lag vs the earliest provider in the cohort, in milliseconds. Relative measurement: the fastest provider on a block reads 0 by construction.",
			// Sub-ms floor because the winner reads near zero by
			// construction; a 5ms first bucket used to collapse every
			// leader's p50 to ~2.5ms (histogram_quantile interpolation
			// artifact inside [0,5ms]). Fine buckets from 0.5ms up
			// through 10s cover same-frame ties through multi-second
			// stragglers on every chain in the cohort (Solana ~400ms
			// slots, Base 2s blocks, Ethereum 12s blocks).
			Buckets: []float64{
				0.5, 1, 2, 3, 5, 8, 12, 20, 35, 60,
				100, 160, 260, 420, 680, 1100, 1800, 3000, 5000, 10000,
			},
			ConstLabels: regionLabels,
		},
		[]string{"provider", "chain"},
	)

	headWins = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name:        "ws_head_wins_total",
			Help:        "Blocks where this provider was the first in the cohort to push the head/slot. Only counted when at least 2 providers saw the block.",
			ConstLabels: regionLabels,
		},
		[]string{"provider", "chain"},
	)

	headBlocksSeen = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name:        "ws_head_blocks_seen_total",
			Help:        "Distinct blocks/slots this provider pushed within the cohort settle window. Ratio against the cohort max is the coverage score.",
			ConstLabels: regionLabels,
		},
		[]string{"provider", "chain"},
	)

	wsReconnects = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name:        "ws_reconnects_total",
			Help:        "WebSocket reconnections per (provider, chain) since process start. Sustained non-zero rate flags an unstable endpoint.",
			ConstLabels: regionLabels,
		},
		[]string{"provider", "chain"},
	)

	wsHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name:        "ws_health",
			Help:        "1 when the subscription is connected and delivered a message in the last 120s, 0 otherwise.",
			ConstLabels: regionLabels,
		},
		[]string{"provider", "chain"},
	)

	headBlockGap = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name:        "ws_block_gap_total",
			Help:        "Blocks the cohort saw but this provider missed (absent from the 5s settle window while its connection was otherwise live).",
			ConstLabels: regionLabels,
		},
		[]string{"provider", "chain"},
	)
)

// StartMetricsServer binds /metrics + /health + /logs on addr. Blocking
// call, run in its own goroutine.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ws-head-latency harness · OpenChainBench № 081"))
	})
	return http.ListenAndServe(addr, mux)
}
