package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metric names intentionally match the no-key rpc-capabilities harness
// so the shared Prometheus recording rules (ocb:rpc_latency_*) pick up
// keyed providers with zero rule changes. The `tier="keyed"` label
// disambiguates: no series collision is possible today because provider
// slugs are disjoint between the two harnesses (infura/alchemy/… vs
// publicnode/drpc/…). If a provider ever appears in BOTH tiers, its
// keyed slug must stay distinct (e.g. `drpc-free-tier`) — the per-chain
// no-key bench formulas select providers by exact slug.
var (
	rpcLatency = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_latency_milliseconds",
			Help: "Latest observed HTTP round-trip in milliseconds for `eth_getBlockByNumber(latest)` (EVM) / `getSlot` (Solana) against a keyed free-tier RPC endpoint.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	// No latency histogram, warm or cold, since 2026-10-29. Both existed and
	// both claimed to drive p50/p90/p99 via quantile_over_time, which is not
	// even a function you can apply to bucket series. The percentiles come
	// from quantile_over_time over the two gauges, and no spec ever selected
	// rpc_latency_milliseconds_histogram_bucket or its cold twin. Together
	// they were 3640 series per Prometheus for no query. See the same note in
	// ../../../rpc-capabilities/cmd/script/metrics.go.

	// Cold arm. The existing rpc_latency_milliseconds series becomes the WARM
	// one from 2026-10-08: a probe on a pooled connection, which is what a
	// server-side application with a connection pool experiences. These two
	// record the same call on a connection that is never reused, which is
	// what a one-shot client or a serverless invocation experiences.
	//
	// Separate metric names rather than a `mode` label on the existing ones,
	// deliberately: the nine keyed specs and the recording rules select on the
	// current label set, and adding a dimension to a metric a spec already
	// queries is how you silently turn a published column into two series and
	// blank it. Same reason the panel label has to equal the provider slug.
	//
	// History note for whoever reads a chart across this date: before
	// 2026-10-08 neither arm existed. Every probe shared one implicit
	// transport, so a call was warm or cold by accident, depending on how
	// often its hostname happened to be touched. Series before that date are
	// a mixture and are not comparable with either arm after it.
	rpcLatencyCold = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_latency_cold_milliseconds",
			Help: "Latest observed HTTP round-trip in milliseconds on a connection that is NEVER reused (DNS + TCP + TLS paid every call), for `eth_getBlockByNumber(latest)` (EVM) / `getSlot` (Solana) against a keyed RPC endpoint.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	rpcCallTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_call_total",
			Help: "Keyed RPC probe outcomes: ok | http_err | jsonrpc_err | stale | timeout | quota_paused.",
		},
		[]string{"provider", "chain", "region", "result", "tier"},
	)

	rpcHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_health",
			Help: "1 when the last keyed probe was fresh + valid, 0 otherwise.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	quotaUsedRatio = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_keyed_quota_used_ratio",
			Help: "Fraction of this region's monthly request budget consumed per provider (probing pauses at 0.90).",
		},
		[]string{"provider", "region"},
	)

	// ---- bench 310, API coverage. See coverage.go. ----
	//
	// A separate metric family rather than an `api` label on rpc_latency_*,
	// for the reason written above about the cold arm: adding a dimension to
	// a metric nine specs already query splits a published column into two
	// series and blanks it.
	//
	// The 0 is load-bearing and it is a claim about the provider: it means
	// they were asked and refused. When we could not ask, nothing is written
	// at all, so the cell renders blank and reads as "not probed". A panel
	// column resolves a missing provider to null for that cell alone
	// (ledger-table.tsx colValue), so absence is a usable third state; only
	// the HEADLINE metric drops a row when it does not resolve.
	rpcAPISupported = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_api_supported",
			Help: "1 when the provider served this API, 0 when it was asked and refused. Absent when no verdict was reached (timeout, paused quota, exhausted credits, unusable key) - never 0 for our own failures.",
		},
		[]string{"provider", "chain", "api", "region", "tier"},
	)

	// The witness that the probe ran. A capability gauge answering every six
	// hours with the same value is indistinguishable from a frozen one, which
	// is how a Coinbase feed sat still for 20 days and passed every check we
	// had. This counter is the only thing that separates a live 1 from a
	// stale 1, which is why the page spends one of its nine columns on it.
	rpcAPIProbeTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_api_probe_total",
			Help: "API coverage probe outcomes: ok | unsupported | forbidden | key_unusable | credits_exhausted | quota_paused | not_applicable | unclassified | http_err | timeout.",
		},
		[]string{"provider", "chain", "api", "result", "region", "tier"},
	)

	// The largest block span the provider accepted for each eth_getLogs
	// filter shape. 0 means it refused even the smallest span tried. This is
	// a number rather than a boolean because a refusal freezes an indexer's
	// cursor, so the usable range is the thing a reader has to plan around,
	// not merely whether the method answers.
	rpcGetLogsMaxRange = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_getlogs_max_range_blocks",
			Help: "Largest eth_getLogs block span accepted, per filter shape (nofilter | address | topics).",
		},
		[]string{"provider", "chain", "filter_shape", "region", "tier"},
	)
)

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
