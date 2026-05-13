package main

import (
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// FinalitySample is one measurement of a chain's finality lag.
type FinalitySample struct {
	Chain          string  `json:"chain"`
	LatestBlock    int64   `json:"latest_block"`
	FinalizedBlock int64   `json:"finalized_block"`
	BlockLag       int64   `json:"block_lag"`     // latest - finalized (in blocks)
	LagSeconds     float64 `json:"lag_seconds"`   // wall-clock difference between block timestamps
	FetchLatencyMs int64   `json:"fetch_latency_ms"`
	At             string  `json:"at"`
	Err            string  `json:"error,omitempty"`
	RawSample      string  `json:"raw_sample,omitempty"`
}

var (
	lagSecondsGauge   *prometheus.GaugeVec
	blockLagGauge     *prometheus.GaugeVec
	latestBlockGauge  *prometheus.GaugeVec
	finalizedBlockGauge *prometheus.GaugeVec
	fetchLatencyGauge *prometheus.GaugeVec
	lastRefreshGauge  *prometheus.GaugeVec
	fetchErrors       *prometheus.CounterVec
	healthOK          *prometheus.GaugeVec
)

func init() {
	lagSecondsGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l1_finality_lag_seconds",
			Help: "Wall-clock difference between latest-block and finalized-block timestamps. Lower is faster finality.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(lagSecondsGauge)

	blockLagGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l1_finality_block_lag",
			Help: "Difference in block height between latest and finalized.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(blockLagGauge)

	latestBlockGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l1_latest_block",
			Help: "Highest block height reported by the chain RPC.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(latestBlockGauge)

	finalizedBlockGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l1_finalized_block",
			Help: "Highest finalized block height reported by the chain RPC.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(finalizedBlockGauge)

	fetchLatencyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l1_finality_fetch_latency_milliseconds",
			Help: "Wall-clock time of the most recent RPC pair that produced a sample.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(fetchLatencyGauge)

	lastRefreshGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l1_finality_last_refresh_timestamp_seconds",
			Help: "Unix timestamp of the last successful sample.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(lastRefreshGauge)

	fetchErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "l1_finality_fetch_errors_total",
			Help: "Total fetch failures per chain, by error type.",
		},
		[]string{"chain", "error_type"},
	)
	prometheus.MustRegister(fetchErrors)

	healthOK = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l1_finality_health",
			Help: "1 if the most recent sample succeeded, 0 if it errored.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(healthOK)
}

func recordSample(s FinalitySample) {
	if s.Err != "" {
		fetchErrors.WithLabelValues(s.Chain, classifyError(s.Err)).Inc()
		healthOK.WithLabelValues(s.Chain).Set(0)
		return
	}
	lagSecondsGauge.WithLabelValues(s.Chain).Set(s.LagSeconds)
	blockLagGauge.WithLabelValues(s.Chain).Set(float64(s.BlockLag))
	latestBlockGauge.WithLabelValues(s.Chain).Set(float64(s.LatestBlock))
	finalizedBlockGauge.WithLabelValues(s.Chain).Set(float64(s.FinalizedBlock))
	fetchLatencyGauge.WithLabelValues(s.Chain).Set(float64(s.FetchLatencyMs))
	lastRefreshGauge.WithLabelValues(s.Chain).Set(float64(time.Now().Unix()))
	healthOK.WithLabelValues(s.Chain).Set(1)
}

func classifyError(msg string) string {
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

// Per-chain debug snapshot — exposed via /debug/finality.
var (
	debugMu        sync.Mutex
	debugSnapshots = map[string]*FinalitySample{}
)

func recordDebugSnapshot(s FinalitySample) {
	cp := s
	debugMu.Lock()
	debugSnapshots[s.Chain] = &cp
	debugMu.Unlock()
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	setupLogsEndpoint(mux)
	setupFinalityDebugEndpoint(mux)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("OK")) })
	return http.ListenAndServe(addr, mux)
}
