package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// All gauges are keyed by `provider=<OCB slug>`. Naming convention is
// `portfolio_<metric>` so a reader can tell at a glance the value
// comes from the portfolio-chain-coverage harness. Gauges are
// publish-then-leave: a failed cycle for one provider leaves its
// previous values in place (Prom retention carries them forward) and
// the failure is bucketed in portfolio_probe_errors_total.
var (
	portfolioChainsListed = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "portfolio_chains_listed",
			Help: "Number of chains the provider self-declares support for via a machine-readable catalog endpoint. listed_source=declared means a standalone chain-catalog endpoint (CoinStats /wallet/blockchains, Zerion /v1/chains/, Mobula /api/1/blockchains); listed_source=probe means no catalog endpoint exists and the count is the networks visible in the portfolio probe response (Zapper portfolioV2 byNetwork, Moralis net-worth accepted chains).",
		},
		[]string{"provider", "listed_source"},
	)

	portfolioChainsVerified = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "portfolio_chains_verified",
			Help: "Number of distinct chains where the provider's wallet-portfolio API returned a real balance for the canonical test addresses (Binance 8 EVM hot wallet + fixed SOL + fixed BTC address, identical across providers). A chain counts when its balance value is > $1, or when the native token amount is > 0 and no USD value is present in the response.",
		},
		[]string{"provider"},
	)

	portfolioProbeLatencyMs = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "portfolio_probe_latency_ms",
			Help: "Aggregate HTTP round-trip in milliseconds across all calls of the provider's last probe cycle (2-3 calls per provider, including the single allowed retry).",
		},
		[]string{"provider"},
	)

	portfolioProbeErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "portfolio_probe_errors_total",
			Help: "Total probe failures per provider, bucketed by kind: timeout, auth, rate_limit, server_error, not_found, parse, other.",
		},
		[]string{"provider", "kind"},
	)

	portfolioLastProbeTimestamp = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "portfolio_last_probe_timestamp",
			Help: "Unix timestamp of the last probe cycle that published at least one value for the provider. Liveness/staleness probe for the daily cadence.",
		},
		[]string{"provider"},
	)
)

// classifyError buckets an error string into a small finite enum so
// portfolio_probe_errors_total stays bounded in cardinality. Same
// shape as pm-cohort-stats' classifier so OCB dashboards can reuse
// one template across harnesses.
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
	kind := classifyError(err.Error())
	portfolioProbeErrors.WithLabelValues(provider, kind).Inc()
}

// StartMetricsServer binds /metrics + /health + /logs on addr.
// Blocking call — run in its own goroutine.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("portfolio-chain-coverage harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
