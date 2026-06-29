package main

import (
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Network is a single chain/network entry returned by a provider's listing API.
type Network struct {
	ChainID string `json:"chain_id"` // canonical id (e.g. "1", "8453", "solana") — best effort
	Slug    string `json:"slug"`     // provider's slug (e.g. "eth", "ethereum")
	Name    string `json:"name"`     // human label
	Testnet bool   `json:"testnet"`
}

// ProviderResult is one snapshot of a provider's network list.
type ProviderResult struct {
	Provider string    `json:"provider"`
	Networks []Network `json:"networks"`
	Err      string    `json:"error,omitempty"`
}

var (
	networksSupportedTotal *prometheus.GaugeVec
	networkSupportedFlag   *prometheus.GaugeVec
	networksLastRefresh    *prometheus.GaugeVec
	networksFetchLatency   *prometheus.GaugeVec
	networksFetchErrors    *prometheus.CounterVec
)

func init() {
	networksSupportedTotal = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "networks_supported_total",
			Help: "Number of unique networks officially supported by each onchain data provider.",
		},
		[]string{"provider"},
	)
	prometheus.MustRegister(networksSupportedTotal)

	networkSupportedFlag = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "network_supported",
			Help: "1 if the provider lists this network in its supported networks endpoint, else absent.",
		},
		[]string{"provider", "chain_id", "slug", "name"},
	)
	prometheus.MustRegister(networkSupportedFlag)

	networksLastRefresh = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "networks_last_refresh_timestamp_seconds",
			Help: "Unix timestamp of the last successful refresh per provider.",
		},
		[]string{"provider"},
	)
	prometheus.MustRegister(networksLastRefresh)

	networksFetchLatency = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "networks_fetch_latency_milliseconds",
			Help: "Wall-clock time to fetch the supported-networks listing for each provider.",
		},
		[]string{"provider"},
	)
	prometheus.MustRegister(networksFetchLatency)

	networksFetchErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "networks_fetch_errors_total",
			Help: "Total number of fetch failures per provider, by error type.",
		},
		[]string{"provider", "error_type"},
	)
	prometheus.MustRegister(networksFetchErrors)
}

// Per-provider series state — used to delete stale labels when a network is removed.
var (
	seriesMu      sync.Mutex
	currentSeries = map[string]map[string]prometheus.Labels{} // provider -> "chain_id|slug" -> labels
)

func recordResult(provider string, res ProviderResult, dur time.Duration) {
	networksFetchLatency.WithLabelValues(provider).Set(float64(dur.Milliseconds()))

	if res.Err != "" {
		// quota_exhausted (free-tier 402 on paid providers) is an expected
		// monthly state, neither a fetch error nor an outage.
		// Skipping recordResult entirely keeps the gauge at its last good
		// value (Prom keeps scraping it from the still-running harness),
		// so present_over_time stays >0 and the cron's "offline" alert
		// never fires. Resumes naturally on the next successful fetch.
		if res.Err == "quota_exhausted" {
			return
		}
		errType := classifyError(res.Err)
		networksFetchErrors.WithLabelValues(provider, errType).Inc()
		return
	}

	networksSupportedTotal.WithLabelValues(provider).Set(float64(len(res.Networks)))
	networksLastRefresh.WithLabelValues(provider).Set(float64(time.Now().Unix()))

	seriesMu.Lock()
	defer seriesMu.Unlock()
	previous := currentSeries[provider]
	next := map[string]prometheus.Labels{}

	for _, n := range res.Networks {
		key := n.ChainID + "|" + n.Slug
		labels := prometheus.Labels{
			"provider": provider,
			"chain_id": n.ChainID,
			"slug":     n.Slug,
			"name":     n.Name,
		}
		networkSupportedFlag.With(labels).Set(1)
		next[key] = labels
	}

	// Drop series that disappeared between refreshes.
	for key, labels := range previous {
		if _, ok := next[key]; !ok {
			networkSupportedFlag.Delete(labels)
		}
	}
	currentSeries[provider] = next
}

func classifyError(msg string) string {
	switch {
	case contains(msg, "timeout"):
		return "timeout"
	case contains(msg, "401") || contains(msg, "403") || contains(msg, "unauthorized"):
		return "auth"
	case contains(msg, "429"):
		return "rate_limit"
	case contains(msg, "5"): // crude — 5xx
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

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("OK")) })
	return http.ListenAndServe(addr, mux)
}
