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

	// ---- bench 311, API coverage. See coverage.go. ----
	//
	// Numbered 310 while it was written. Another session shipped
	// server-wallet-cost as 310 the same evening, so this one moved to 311
	// and the cross-reference had to move with it: a stale number sends
	// whoever follows it to a different bench entirely.
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

	// When the published value for this cell was last established.
	//
	// Set only when a verdict was reached and the gauge was written, which is
	// the point: if a provider starts timing out, the capability gauge keeps
	// its last value and this timestamp deliberately stops advancing, so
	// `time() - rpc_api_last_probe_timestamp` is the AGE OF THE PUBLISHED
	// ANSWER rather than the age of our last attempt. A column built on the
	// probe counter instead would keep incrementing on failures and report a
	// stale tick as fresh.
	rpcAPILastProbe = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_api_last_probe_timestamp",
			Help: "Unix seconds when this API verdict was last established. Does not advance while probes fail, so time() minus this is the age of the published answer.",
		},
		[]string{"provider", "chain", "api", "region", "tier"},
	)

	// Round-trip of the coverage probe itself, per method.
	//
	// The calls were already being made and the number was already being
	// measured: probeCoverage took `raw, _, classified, err` from doPost and
	// the discarded second value is the round trip. So a latency per method
	// costs zero additional requests, which is the only reason it is
	// affordable at all: the headline latency cell costs 21.6k requests per
	// region per month at the 120 s cadence, and there are eight methods.
	//
	// Written ONLY when the method was served. A refusal has a round trip
	// too, and it is usually the fastest number on the board, because
	// "method not found" is cheap to produce. Publishing it would rank a
	// provider fast for declining to answer, which is the same fault as
	// publishing a refusal we never received.
	//
	// This is a COLD number and is not comparable with
	// rpc_latency_milliseconds. The coverage probe passes warm=false, which
	// selects coldTransport, which sets DisableKeepAlives, so every call
	// pays DNS, TCP and TLS by construction rather than by luck. Compare it
	// with rpc_latency_cold_milliseconds. Comparing it with the warm arm
	// measures a handshake, which from this container is about 25 ms and was
	// large enough to invert the published order of four providers in
	// October.
	//
	// Sample count is the honest limit: one reading per method per endpoint
	// per coverage pass, and the pass runs every six hours in ONE region, so
	// a 24 h window holds four points. A spec reading this must take its
	// percentile over a window wide enough to mean something and say how
	// many samples that is.
	rpcAPILatency = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_api_latency_milliseconds",
			Help: "Cold round-trip in milliseconds (DNS + TCP + TLS paid every call) of the API coverage probe, per method. Written only when the provider served the method, never for a refusal.",
		},
		[]string{"provider", "chain", "api", "region", "tier"},
	)

	// The largest eth_getLogs block span the provider's RANGE GUARD admits,
	// per filter shape. A number rather than a boolean because a range
	// refusal freezes an indexer's cursor, so the usable width is the thing
	// a reader plans around, not merely whether the method answers.
	//
	// Three things it is not, each measured rather than assumed. See
	// rangeladder.go for the readings.
	//
	// It is not the widest window from which logs will actually be delivered.
	// The ladder's filters match nothing on purpose, because a wide
	// unfiltered window is megabytes per call; Alchemy accepted 1,000,000
	// blocks in 209 ms, which is not a scan. What is left between the request
	// and an empty reply is the static guard on toBlock minus fromBlock, and
	// that guard is what trips before any work is done.
	//
	// It is not a ceiling when the top rung passes. The value is the largest
	// span TESTED and accepted, so a provider that clears every rung
	// publishes a floor.
	//
	// It is not comparable across chains. The unit is blocks, and a block is
	// 12 seconds on Ethereum against 2 on Base, so 10,000 blocks is 33 hours
	// on one and 5.5 on the other. Within a chain tab it ranks; across chains
	// it does not, and a spec publishing it must stay per chain.
	//
	// 0 means the narrowest tested span was refused, which publicnode does
	// for topic-only queries ("Please specify an address in your request").
	// Nothing is written when no definitive answer was reached, same rule as
	// the capability gauge: a timeout is our failure, and inferring a limit
	// from it would publish our own patience as the provider's policy.
	//
	// The nofilter shape is deliberately absent: its reply cannot be bounded,
	// so it keeps its five-block capability column and no range number.
	rpcGetLogsMaxRange = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_getlogs_max_range_blocks",
			Help: "Largest eth_getLogs block span accepted, per filter shape (address | topics), measured with filters that match nothing. `bound` says what the figure is: refused = the provider declined the next rung, so this is its guard; failed = our own call failed above it, so this is a floor; top = every rung passed. Blocks, so comparable within a chain and not across chains.",
		},
		[]string{"provider", "chain", "filter_shape", "bound", "region", "tier"},
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
