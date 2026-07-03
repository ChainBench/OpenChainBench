package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"net/http"
)

// Metrics exposed by the harness.
//
//	relay_solver_balance_usd{kind=total|stables}  gauge — latest snapshot
//	relay_solver_balance_delta_usd{kind, window}  gauge — rolling delta
//	relay_solver_assets_count                     gauge — total assets held
//	relay_solver_poll_duration_seconds            gauge — last poll latency
//	relay_solver_polls_total                      counter — successful polls
//	relay_solver_poll_errors_total                counter — failed polls
//	relay_solver_window_snapshots                 gauge — snapshots in memory
var (
	balanceUSD       *prometheus.GaugeVec
	balanceDeltaUSD  *prometheus.GaugeVec
	assetsCount      prometheus.Gauge
	pollDurationSec  prometheus.Gauge
	pollSuccess      prometheus.Counter
	pollErrors       prometheus.Counter
	windowSnapshots  prometheus.Gauge
)

func init() {
	balanceUSD = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name:        "relay_solver_balance_usd",
			Help:        "Latest snapshot of the Relay solver wallet balance in USD",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
		[]string{"kind"},
	)
	prometheus.MustRegister(balanceUSD)

	balanceDeltaUSD = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name:        "relay_solver_balance_delta_usd",
			Help:        "Balance change in USD over the named rolling window. Positive value = retained margin (floor on Relay revenue).",
			ConstLabels: prometheus.Labels{"provider": "relay"},
		},
		[]string{"kind", "window"},
	)
	prometheus.MustRegister(balanceDeltaUSD)

	assetsCount = prometheus.NewGauge(prometheus.GaugeOpts{
		Name:        "relay_solver_assets_count",
		Help:        "Total distinct assets held in the solver wallet across all chains Mobula indexes",
		ConstLabels: prometheus.Labels{"provider": "relay"},
	})
	prometheus.MustRegister(assetsCount)

	pollDurationSec = prometheus.NewGauge(prometheus.GaugeOpts{
		Name:        "relay_solver_poll_duration_seconds",
		Help:        "Wall-clock time the last portfolio poll took, in seconds",
		ConstLabels: prometheus.Labels{"provider": "relay"},
	})
	prometheus.MustRegister(pollDurationSec)

	pollSuccess = prometheus.NewCounter(prometheus.CounterOpts{
		Name:        "relay_solver_polls_total",
		Help:        "Successful portfolio polls",
		ConstLabels: prometheus.Labels{"provider": "relay"},
	})
	prometheus.MustRegister(pollSuccess)

	pollErrors = prometheus.NewCounter(prometheus.CounterOpts{
		Name:        "relay_solver_poll_errors_total",
		Help:        "Failed portfolio polls",
		ConstLabels: prometheus.Labels{"provider": "relay"},
	})
	prometheus.MustRegister(pollErrors)

	windowSnapshots = prometheus.NewGauge(prometheus.GaugeOpts{
		Name:        "relay_solver_window_snapshots",
		Help:        "Number of snapshots currently held in memory (diagnostic)",
		ConstLabels: prometheus.Labels{"provider": "relay"},
	})
	prometheus.MustRegister(windowSnapshots)
}

// StartMetricsServer exposes /metrics, /logs, /healthz on :2112 per the
// shared OCB harness convention.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	setupLogsEndpoint(mux)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
