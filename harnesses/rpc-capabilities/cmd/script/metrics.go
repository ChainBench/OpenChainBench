package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the OCB public RPC capabilities bench. Names follow
// the `rpc_<measurement>_<unit>` convention used by every other OCB
// harness; the spec YAML uses these directly via PromQL.
//
// Three concerns are emitted from one binary because they share the
// same set of (provider × chain) clients and same scrape interval —
// splitting them across services would triple the Railway footprint
// without reducing complexity.
var (
	rpcLatency = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_latency_milliseconds",
			Help: "Latest observed HTTP round-trip in milliseconds for `eth_getBlockByNumber(latest)` against a public RPC endpoint.",
		},
		[]string{"provider", "chain", "region"},
	)

	rpcLatencyHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "rpc_latency_milliseconds_histogram",
			Help:    "Histogram of public RPC `eth_getBlockByNumber(latest)` latencies — drives the p50/p90/p99 leaderboard via `histogram_quantile` / `quantile_over_time`.",
			Buckets: []float64{50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000},
		},
		[]string{"provider", "chain", "region"},
	)

	rpcCallTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_call_total",
			Help: "Number of RPC calls broken down by result classification: ok, http_err (status != 200 or transport failure), jsonrpc_err (HTTP 200 with `error` field — Ankr/Cloudflare-eth trap), stale (block more than 20 behind cross-provider tip), timeout.",
		},
		[]string{"provider", "chain", "region", "result"},
	)

	rpcHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_health",
			Help: "1 when the most recent latency probe returned a fresh, valid block, 0 otherwise.",
		},
		[]string{"provider", "chain", "region"},
	)

	rpcArchiveDepth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_archive_depth_supported",
			Help: "1 if `eth_getBalance` at (head - depth) returns a non-pruned response, 0 otherwise. depth label is in blocks. The set {300, 7200, 216000, 1296000, 5000000} covers Geth's default pruned cap up through genesis-era full archive.",
		},
		[]string{"provider", "chain", "region", "depth"},
	)

	// ─── Bench 083 rpc-reliability: correctness / integrity metrics ────
	// Emitted from the same probe matrix; consensus.go + integrity.go.

	rpcConsensusLag = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_consensus_lag_blocks",
			Help: "Blocks (slots on Solana) between this provider's reported head and the highest head any probed provider reported for the same chain. Set on every valid head probe (ok or stale); deleted on failure so a dead endpoint ages out instead of freezing at its last lag.",
		},
		[]string{"provider", "chain", "region"},
	)

	rpcHashMismatch = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_hash_mismatch_total",
			Help: "Times a provider reported a block hash at height H that disagrees with the hash at least 2 other-or-same providers agreed on at H (strict plurality). Incremented at most once per (provider, height); a 2-2 reorg split yields no quorum and nobody is counted.",
		},
		[]string{"provider", "chain", "region"},
	)

	rpcLogsCount = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_logs_count",
			Help: "Number of logs the provider returned for the fixed-vector `eth_getLogs` check (canonical USDC contract, 10-block range at a daily-rotating depth behind tip). Deleted when the call errors so a blocked method doesn't freeze a stale count.",
		},
		[]string{"provider", "chain", "region"},
	)

	rpcLogsDisagreement = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_logs_disagreement_total",
			Help: "Times a provider's `eth_getLogs` count for the fixed vector deviated from the strict cross-provider majority count in the same round.",
		},
		[]string{"provider", "chain", "region"},
	)

	rpcStateDisagreement = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_state_disagreement_total",
			Help: "Times a provider's `eth_getBalance` hex at the fixed recent block was not byte-identical to the strict cross-provider majority answer in the same round.",
		},
		[]string{"provider", "chain", "region"},
	)

	rpcIntegrityCheck = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_integrity_check_total",
			Help: "Fixed-vector integrity check outcomes. check is `logs` (eth_getLogs USDC 10-block window) or `balance` (eth_getBalance at a fixed recent block). result is ok (matches majority), error (method blocked, archive gated, transport failure: errors are signal), or disagree (diverged from the >=2-provider majority).",
		},
		[]string{"provider", "chain", "region", "check", "result"},
	)
)

// StartMetricsServer binds /metrics + /health on addr. Blocking call —
// run in its own goroutine.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("rpc-capabilities harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
