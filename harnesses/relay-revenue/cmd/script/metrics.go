package main

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// metrics.go — Prom surface for the Relay revenue bench.
//
// Per OCB convention every harness binds :2112 and exposes
// /metrics, /health, /logs. Naming prefix `relay_` to keep the
// global namespace clean.

var (
	// Sliding-window aggregates over priced swaps. The polling loop
	// upserts into SQLite; a background goroutine queries the DB on a
	// 5-min cadence and SET()s these gauges.
	relayRevenueUSD = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "relay_revenue_usd",
			Help: "Sum of implied_margin_usd over the window. Computed as usd_in - usd_out - gas - appFees per swap, then summed over swaps with status='success' AND priced=1.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
		[]string{"window"},
	)
	relayVolumeUSD = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "relay_volume_usd",
			Help: "Sum of usd_in (data.metadata.currencyIn priced via spot) over the window.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
		[]string{"window"},
	)
	relaySwapCount = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "relay_swap_count",
			Help: "Count of priced success swaps in the window.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
		[]string{"window"},
	)
	relayTakeRateBps = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "relay_take_rate_bps",
			Help: "implied_margin / volume in basis points over the rolling 24h window.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
	)

	// Pricing coverage counters — keep snapshots in DB but surface
	// totals here so dashboards can flag a sudden spike in unpriced
	// swaps (e.g. CoinGecko down).
	relaySwapsPricedTotal = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "relay_swaps_priced_total",
			Help: "Cumulative count of success swaps stored with priced=1. Reflects DB state, not a counter — re-scraped from SQLite each refresh.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
	)
	relaySwapsUnpricedTotal = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "relay_swaps_unpriced_total",
			Help: "Cumulative count of success swaps stored with priced=0 (at least one leg failed to price).",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
	)

	// API hygiene counters.
	relayAPIRequestTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "relay_api_request_total",
			Help: "Total GET https://api.relay.link/requests calls since process start.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
	)
	relayAPIErrorsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "relay_api_errors_total",
			Help: "Total upstream errors broken out by error class.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
		[]string{"reason"},
	)

	relayLastPollTimestamp = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "relay_last_poll_timestamp_seconds",
			Help: "Unix timestamp of the most recent successful poll cycle. Stalls flag a frozen worker.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
	)
	relayPollDurationSeconds = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "relay_poll_duration_seconds",
			Help: "Wall-clock duration of the most recent poll cycle (paginating until catch-up).",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
	)
	relayNewSwapsPerCycle = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "relay_new_swaps_per_cycle",
			Help: "Count of newly priced success swaps in the most recent poll cycle.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
	)

	// Sanity-bound rejections. A non-zero rate here means either Relay
	// is emitting a corrupted amountUsd hint, an oracle returned a
	// garbage price, or a token's reported decimals don't match its
	// actual unit. Labels: hint|amount|gas|appfee|margin.
	relaySwapsDroppedImplausible = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "relay_swaps_dropped_implausible_total",
			Help: "Swaps (or legs) dropped because a USD value exceeded the per-leg / per-margin sanity envelope.",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
		[]string{"reason"},
	)
)

// metricsWindow is a (label, retention) pair for the refresh goroutine.
type metricsWindow struct {
	label    string
	duration time.Duration
}

var metricsWindows = []metricsWindow{
	{"24h", 24 * time.Hour},
	{"7d", 7 * 24 * time.Hour},
	{"30d", 30 * 24 * time.Hour},
}

// startMetricsRefresh runs forever, querying the store on a 5-min
// cadence and updating the window gauges. Cancelled by the parent ctx.
func startMetricsRefresh(ctx context.Context, store *Store) {
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	// Fire once shortly after boot so /metrics isn't all-zero for the
	// first 5 minutes — important for visual debugging during deploys.
	timer := time.NewTimer(15 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			refreshAggregates(ctx, store)
		case <-tick.C:
			refreshAggregates(ctx, store)
		}
	}
}

func refreshAggregates(ctx context.Context, store *Store) {
	now := time.Now().Unix()
	for _, w := range metricsWindows {
		since := now - int64(w.duration.Seconds())
		agg, err := store.AggregateSince(ctx, since)
		if err != nil {
			fmt.Printf("[metrics] aggregate %s failed: %v\n", w.label, err)
			continue
		}
		relayRevenueUSD.WithLabelValues(w.label).Set(agg.MarginUSD)
		relayVolumeUSD.WithLabelValues(w.label).Set(agg.VolumeUSD)
		relaySwapCount.WithLabelValues(w.label).Set(float64(agg.Count))
		if w.label == "24h" {
			if agg.VolumeUSD > 0 {
				relayTakeRateBps.Set((agg.MarginUSD / agg.VolumeUSD) * 10000.0)
			} else {
				relayTakeRateBps.Set(0)
			}
		}
	}
	if priced, unpriced, err := store.PricedCounts(ctx); err == nil {
		relaySwapsPricedTotal.Set(float64(priced))
		relaySwapsUnpricedTotal.Set(float64(unpriced))
	}
}

// startMetricsServer binds /metrics + /logs + /health on addr.
// Blocking — run in its own goroutine.
func startMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("relay-revenue harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
