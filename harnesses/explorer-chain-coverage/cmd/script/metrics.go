package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Gauges are keyed by `provider=<OCB slug>` and publish-then-leave:
// a failed or quota-truncated cycle publishes nothing and Prometheus
// retention carries the previous values forward.
var (
	explorerChainsRegistered = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "explorer_chains_registered",
			Help: "Mainnet chains the explorer family self-declares through a machine-readable surface. registered_source=registry means a standalone registry/chainlist endpoint (Blockscout Chainscout, Etherscan chainlist, Routescan blockchains, Blockchair stats, OKLink summary); registered_source=pinned means no machine surface exists and the harness pins the list (Subscan network subdomains).",
		},
		[]string{"provider", "registered_source"},
	)

	explorerChainsVerified = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "explorer_chains_verified",
			Help: "Registered mainnet chains whose explorer API passed the freshness probe this cycle: latest indexed block younger than the freshness window (default 60m). A 200 from a stalled indexer does not count, so this measures working indexers, not reachable web servers.",
		},
		[]string{"provider"},
	)

	explorerChainsTop50 = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "explorer_chains_top50",
			Help: "Of the pinned 50 most economically active mainnets (DefiLlama TVL + fees blend, see harness top50.go), how many passed the freshness probe on this family. Anti-inflation column: raw counts reward ghost chains, this answers the integrator question.",
		},
		[]string{"provider"},
	)

	explorerProbeLatencyMs = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "explorer_probe_latency_ms",
			Help: "Aggregate HTTP round-trip in milliseconds across all calls of the provider's last probe cycle.",
		},
		[]string{"provider"},
	)

	explorerProbeErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "explorer_probe_errors_total",
			Help: "Probe failures per provider, bucketed by kind: timeout, auth, rate_limit, server_error, not_found, parse, other.",
		},
		[]string{"provider", "kind"},
	)

	explorerLastProbeTimestamp = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "explorer_last_probe_timestamp",
			Help: "Unix timestamp of the last cycle that published at least one value for the provider. Staleness alarm.",
		},
		[]string{"provider"},
	)

	explorerProbeCalls = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "explorer_probe_calls_total",
			Help: "Upstream HTTP attempts per provider, retries included. All cohort surfaces are free; this guards against accidental volume drift.",
		},
		[]string{"provider"},
	)
)

// countCall tallies one upstream HTTP attempt for a provider.
func countCall(provider string) {
	explorerProbeCalls.WithLabelValues(provider).Inc()
}

// classifyError buckets an error string into a bounded enum (same
// classifier shape as the other OCB harnesses).
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
	case contains(msg, "parse"), contains(msg, "unmarshal"), contains(msg, "unexpected"):
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

// recordError logs and buckets one probe failure for a provider.
func recordError(provider string, err error) {
	explorerProbeErrors.WithLabelValues(provider, classifyError(err.Error())).Inc()
}

// StartMetricsServer binds /metrics + /health + /logs on addr.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("explorer-chain-coverage harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
