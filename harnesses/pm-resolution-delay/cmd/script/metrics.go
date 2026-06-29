package main

import (
	"net/http"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// pmres_* namespace: Polymarket resolution-delay bench. Delay is anchored at
// the FIRST Optimistic Oracle ProposePrice for the question (the moment the
// outcome was submitted on-chain) because Gamma's closedTime is written AT
// resolution (verified live: closedTime == QuestionResolved block timestamp)
// and endDate is a scheduled buffer that 59% of markets resolve before.
var (
	// 5min .. 14 days. 7200 (=2h) sits on a bucket edge on purpose: the UMA
	// challenge window is 2h, so "resolved within 2h of proposal" is the
	// claim the bench fact-checks.
	delayBuckets = []float64{300, 900, 1800, 3600, 7200, 14400, 43200, 86400, 172800, 604800, 1209600}

	resolutionDelay = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pmres_resolution_delay_seconds",
		Help:    "QuestionResolved block timestamp minus first OO ProposePrice block timestamp for the same questionID. Includes the UMA challenge window (~2h), so the floor is the market's liveness. disputed=true means at least one OO DisputePrice / adapter QuestionReset occurred before resolution.",
		Buckets: delayBuckets,
	}, []string{"category", "disputed"})

	resolutionsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pmres_resolutions_total",
		Help: "QuestionResolved events observed and successfully joined to a proposal. Re-counts the 7-day backfill window after a restart (no DB), so prefer rate()/increase() over raw values.",
	}, []string{"category", "disputed"})

	disputesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pmres_disputes_total",
		Help: "Questions that saw their first OO DisputePrice (or adapter QuestionReset) before resolution. Counted once per question, not per dispute round.",
	}, []string{"category"})

	pendingMarkets = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "pmres_pending_markets",
		Help: "Gamma markets past their scheduled endDate, still open (closed=false) and not resolved, capped at 30 days overdue. These are the markets users are currently waiting on.",
	}, []string{"category"})

	oldestPendingAge = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "pmres_oldest_pending_age_seconds",
		Help: "now minus the oldest endDate among pending markets (within the 30-day lookback).",
	})

	listenerHealth = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "pmres_listener_health",
		Help: "1 if Polygon logs were polled successfully in the last 5 minutes.",
	})

	rpcErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pmres_rpc_errors_total",
		Help: "Polygon JSON-RPC failures by kind: http, rpc_error, decode, timeout.",
	}, []string{"kind"})
)

// lastPollOK is the unix time of the last successful incremental log poll.
var lastPollOK atomic.Int64

func healthLoop() {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for range t.C {
		if time.Since(time.Unix(lastPollOK.Load(), 0)) < 5*time.Minute {
			listenerHealth.Set(1)
		} else {
			listenerHealth.Set(0)
		}
	}
}

// StartMetricsServer binds /metrics + /health + /logs on addr. Blocking call,
// run in its own goroutine. :2112 is the OCB convention; Railway's $PORT is
// deliberately ignored so the shared Prometheus always finds the listener.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("pm-resolution-delay harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
