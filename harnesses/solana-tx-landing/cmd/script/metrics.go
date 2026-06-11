package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the Solana transaction landing-market bench.
// Naming convention `solana_landing_<measurement>` matches the rest of
// the OCB suite. The spec YAML uses these directly via PromQL.
//
// The bench is observational — we don't send tx ourselves. We count
// landed tx that touched each landing service's published tip wallets
// and aggregate by service. The result tells us which services carry
// what share of Solana's actual tipped-tx flow.
var (
	// Per-service landed-tx counter. Incremented on every confirmed
	// logsSubscribe notification matching one of the service's tip
	// wallets. Dedup via signature cache so each tx counts once.
	solanaLandingTxTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "solana_landing_tx_total",
			Help: "Number of confirmed Solana transactions attributed to each landing service, counted via the service's known on-chain tip wallets. Observational — increments on every dedup'd logsSubscribe notification matching a tip-wallet mention.",
		},
		[]string{"service"},
	)

	// Per-service WebSocket subscription health. 1 = subscribed and
	// receiving notifications; 0 = disconnected, reconnecting, or
	// silently broken. Used to flag attribution gaps.
	solanaLandingSubHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "solana_landing_subscription_health",
			Help: "1 when the WebSocket subscription for this service's tip wallets is live and receiving notifications, 0 otherwise.",
		},
		[]string{"service"},
	)

	// Reconnect counter. Surfaces WS stability over the day.
	solanaLandingReconnects = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "solana_landing_reconnects_total",
			Help: "Total WebSocket reconnects since process start. Sustained growth signals public mainnet-beta endpoint instability.",
		},
	)

	// Last slot we observed an event for, per service. Lets the
	// freshness probe surface "Astralane silent for 30 min" before
	// the user notices.
	solanaLandingLastSlot = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "solana_landing_last_slot",
			Help: "Slot of the most recent observed event per service. Use against the current Solana slot to detect silent subscriptions.",
		},
		[]string{"service"},
	)
)

// StartMetricsServer binds /metrics + /health + /diag on addr. Blocking
// call - run in its own goroutine.
//
// /diag?host=<host>[:<port>] runs a TCP connect timing from inside the
// container to the given host. Used during sponsor onboarding to share
// the actual Railway us-east network latency to a provider's endpoint
// (e.g. ny1.0slot.trade) without needing a shell into the container.
// Default port 443 if omitted. 5 s timeout.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/diag", diagHandler)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("solana-tx-landing harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}

// diagHandler does a TCP connect from inside the container to the given
// host and returns the elapsed time. Fail-secure: requires X-Logs-Token
// header match. Without this gate /diag becomes an SSRF-style port
// scanner of the Railway internal mesh (any *.railway.internal:* port).
func diagHandler(w http.ResponseWriter, r *http.Request) {
	expectedToken := os.Getenv("LOGS_TOKEN")
	if expectedToken == "" {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("X-Logs-Token") != expectedToken {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	host := r.URL.Query().Get("host")
	if host == "" {
		http.Error(w, "usage: /diag?host=example.com:443 (port optional, defaults to 443)", http.StatusBadRequest)
		return
	}
	if _, _, err := net.SplitHostPort(host); err != nil {
		host = host + ":443"
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", host, 5*time.Second)
	elapsed := time.Since(start).Round(time.Microsecond)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, "connect_fail host=%s elapsed=%s err=%v\n", host, elapsed, err)
		return
	}
	defer conn.Close()
	fmt.Fprintf(w, "connect_ok host=%s elapsed=%s\n", host, elapsed)
}
