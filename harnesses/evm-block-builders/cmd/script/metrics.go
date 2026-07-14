package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for bench 085 (evm-block-builders). Prefix `ebb_`.
// The spec YAML (benchmarks/evm-block-builders.yml) queries these
// directly via PromQL.
var (
	/* ---- Ethereum builder attribution (headline) ---- */

	// Per-builder block counter, attributed via extraData substring
	// table. Includes the synthetic slugs "vanilla" (client-default
	// extraData → locally built) and "other" (unrecognized tag).
	blocksTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ebb_blocks_total",
			Help: "Ethereum mainnet blocks attributed to each builder via the block's extraData self-label. builder=vanilla means client-default extraData (locally built); builder=other means an unrecognized tag (also logged raw for table growth).",
		},
		[]string{"builder"},
	)

	// Blocks whose extraData carried an unrecognized tag. The raw string
	// is logged so the attribution table can grow (016 pattern).
	unattributedTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ebb_unattributed_total",
			Help: "Blocks whose extraData tag was non-empty but not in the curated builder table. Every occurrence logs the raw extraData for later table growth.",
		},
	)

	ethPollHealth = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ebb_eth_poll_health",
			Help: "1 when the Ethereum head poll is succeeding, 0 after the last poll errored.",
		},
	)

	ethPollErrors = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ebb_eth_poll_errors_total",
			Help: "Ethereum RPC poll errors since process start.",
		},
	)

	ethLastBlock = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ebb_eth_last_block",
			Help: "Most recent Ethereum block number attributed by the harness. Freshness probe target.",
		},
	)

	/* ---- Relay bidtrace cross-check ---- */

	relayPayloadsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ebb_relay_payloads_total",
			Help: "Delivered payloads (proposer_payload_delivered bidtraces) counted per MEV-Boost relay, deduped per relay via a slot high-water-mark. The same slot on multiple relays is normal (multi-homed bids), so this measures relay share, not a partition of blocks.",
		},
		[]string{"relay"},
	)

	relayPollErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ebb_relay_poll_errors_total",
			Help: "Bidtrace poll errors per relay since process start.",
		},
		[]string{"relay"},
	)

	relayHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ebb_relay_health",
			Help: "1 when the last bidtrace poll for this relay succeeded, 0 otherwise.",
		},
		[]string{"relay"},
	)

	relayLastSlot = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ebb_relay_last_slot",
			Help: "Highest slot seen in bidtraces per relay.",
		},
		[]string{"relay"},
	)

	/* ---- Arbitrum sequencer feed soft-confirmation lag ---- */

	arbSoftConfLag = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name: "ebb_arb_softconf_lag_milliseconds",
			Help: "Lag from a block's sequencer-feed arrival to the same block being visible on the public Arbitrum RPC head. Quantized by the ~300ms RPC poll interval.",
			Buckets: []float64{
				25, 50, 75, 100, 150, 200, 300, 400, 500, 750,
				1000, 1500, 2000, 3000, 5000, 10000,
			},
		},
	)

	arbLagSamples = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ebb_arb_lag_samples_total",
			Help: "Arbitrum soft-confirmation lag samples recorded.",
		},
	)

	arbFeedHealth = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ebb_arb_feed_health",
			Help: "1 while the Arbitrum sequencer feed WebSocket is connected, 0 otherwise.",
		},
	)

	arbFeedMessages = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ebb_arb_feed_messages_total",
			Help: "Sequencer feed messages received.",
		},
	)

	arbDerivedOffset = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ebb_arb_derived_offset",
			Help: "Runtime-derived sequenceNumber→blockNumber offset (expected ≈22207817). Drift signals a feed format change.",
		},
	)

	arbRPCErrors = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ebb_arb_rpc_errors_total",
			Help: "Arbitrum RPC head-poll errors since process start.",
		},
	)

	/* ---- Base flashblocks ---- */

	baseFlashblockInterval = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name: "ebb_base_flashblock_interval_milliseconds",
			Help: "Wall-clock interval between consecutive flashblock frames on the Base flashblocks WebSocket (advertised rhythm: ~200ms).",
			Buckets: []float64{
				50, 100, 150, 200, 250, 300, 400, 500, 750,
				1000, 2000, 5000,
			},
		},
	)

	baseSoftConfLag = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name: "ebb_base_softconf_lag_milliseconds",
			Help: "Lag from the first flashblock of a Base block arriving on the stream to that block being visible on the public Base RPC head. Quantized by the ~300ms RPC poll interval.",
			Buckets: []float64{
				100, 250, 500, 750, 1000, 1250, 1500, 1750, 2000,
				2500, 3000, 5000, 10000,
			},
		},
	)

	baseLagSamples = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ebb_base_lag_samples_total",
			Help: "Base soft-confirmation lag samples recorded.",
		},
	)

	baseFeedHealth = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "ebb_base_feed_health",
			Help: "1 while the Base flashblocks WebSocket is connected, 0 otherwise.",
		},
	)

	baseFrames = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ebb_base_frames_total",
			Help: "Flashblock frames received.",
		},
	)

	baseParseFailures = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ebb_base_parse_failures_total",
			Help: "Flashblock frames that failed brotli+JSON decoding (cadence still recorded).",
		},
	)

	baseRPCErrors = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "ebb_base_rpc_errors_total",
			Help: "Base RPC head-poll errors since process start.",
		},
	)

	/* ---- Shared ---- */

	streamReconnects = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ebb_stream_reconnects_total",
			Help: "WebSocket reconnects per stream (arb-feed, base-flashblocks) since process start.",
		},
		[]string{"stream"},
	)
)

// StartMetricsServer binds /metrics + /health + /logs on addr. Blocking
// call, run in its own goroutine.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("evm-block-builders harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
