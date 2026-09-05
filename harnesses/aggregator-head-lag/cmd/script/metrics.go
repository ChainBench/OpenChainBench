package main

import (
	"fmt"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"net/http"
	"sync"
)

var (
	// Pool discovery latency metric
	poolDiscoveryLatency *prometheus.GaugeVec
	poolDiscoveryErrors  *prometheus.CounterVec

	// REST API latency metrics
	restAPILatency     *prometheus.HistogramVec
	restAPIErrors      *prometheus.CounterVec
	restAPIStatusCodes *prometheus.CounterVec

	// Quote API latency metrics
	quoteAPILatency     *prometheus.HistogramVec
	quoteAPIErrors      *prometheus.CounterVec
	quoteAPIStatusCodes *prometheus.CounterVec

	// Metadata coverage metrics
	metadataCoverageTotal   *prometheus.CounterVec
	metadataCoverageSuccess *prometheus.CounterVec
	metadataAPILatency      *prometheus.HistogramVec

	// Head lag metrics
	headLagBlocks     *prometheus.GaugeVec
	headLagSeconds    *prometheus.GaugeVec
	blockchainHead    *prometheus.GaugeVec
	aggregatorHead    *prometheus.GaugeVec
	headLagErrors     *prometheus.CounterVec
	headLagRefSeconds *prometheus.GaugeVec
	headLagRefMatches *prometheus.CounterVec
	refClockEntries   prometheus.Gauge

	// Fast-trade latency (for comparison with Pulse V2)
	fastTradeLatency *prometheus.GaugeVec

	// Mobula detailed head lag (with breakdown)
	mobulaHeadLagDetailed      *prometheus.GaugeVec
	mobulaProcessingLagSeconds *prometheus.GaugeVec
	mobulaNetworkLagSeconds    *prometheus.GaugeVec

	// Latest tx_hash seen per pool. Kept at most 1 series per (chain, pool_address)
	// via explicit Delete of the previous label set in RecordMobulaLastTx.
	// Alert annotations query this gauge to include a clickable tx link.
	mobulaLastTxHash *prometheus.GaugeVec
	mobulaLastTxMu   sync.Mutex
	mobulaLastTxSeen = make(map[string]string) // key: "chain:pool_address" -> last tx_hash

	// WebSocket connection lifecycle (deco/reco visibility in Grafana/Prom)
	wsReconnects *prometheus.CounterVec
	wsConnected  *prometheus.GaugeVec
)

func init() {
	poolDiscoveryLatency = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pool_discovery_latency_milliseconds",
			Help: "Time from pool creation on-chain to first trade detection (pool discovery latency)",
		},
		[]string{"aggregator", "chain", "region"},
	)
	prometheus.MustRegister(poolDiscoveryLatency)

	poolDiscoveryErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "pool_discovery_errors_total",
			Help: "Total number of errors when fetching pool discovery data",
		},
		[]string{"aggregator", "error_type", "region"},
	)
	prometheus.MustRegister(poolDiscoveryErrors)

	// REST API latency histogram with buckets optimized for API response times
	restAPILatency = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "rest_api_latency_milliseconds",
			Help:    "REST API response latency in milliseconds",
			Buckets: []float64{50, 100, 200, 500, 1000, 2000, 5000, 10000},
		},
		[]string{"aggregator", "endpoint", "chain", "region"},
	)
	prometheus.MustRegister(restAPILatency)

	// REST API errors counter
	restAPIErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rest_api_errors_total",
			Help: "Total number of REST API errors",
		},
		[]string{"aggregator", "endpoint", "chain", "error_type", "region"},
	)
	prometheus.MustRegister(restAPIErrors)

	// REST API status codes counter
	restAPIStatusCodes = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rest_api_status_codes_total",
			Help: "Total count of REST API responses by status code",
		},
		[]string{"aggregator", "endpoint", "chain", "status_code", "region"},
	)
	prometheus.MustRegister(restAPIStatusCodes)

	// Quote API latency histogram
	quoteAPILatency = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "quote_api_latency_milliseconds",
			Help:    "Quote API response latency in milliseconds",
			Buckets: []float64{50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000},
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteAPILatency)

	// Quote API errors counter
	quoteAPIErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "quote_api_errors_total",
			Help: "Total number of Quote API errors",
		},
		[]string{"provider", "chain", "error_type", "region"},
	)
	prometheus.MustRegister(quoteAPIErrors)

	// Quote API status codes counter
	quoteAPIStatusCodes = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "quote_api_status_codes_total",
			Help: "Total count of Quote API responses by status code",
		},
		[]string{"provider", "chain", "status_code", "region"},
	)
	prometheus.MustRegister(quoteAPIStatusCodes)

	// Metadata coverage - total checks per provider/chain/field
	metadataCoverageTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "metadata_coverage_checks_total",
			Help: "Total number of metadata coverage checks",
		},
		[]string{"provider", "chain", "field", "region"},
	)
	prometheus.MustRegister(metadataCoverageTotal)

	// Metadata coverage - successful (field present) checks
	metadataCoverageSuccess = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "metadata_coverage_success_total",
			Help: "Total number of successful metadata coverage checks (field present)",
		},
		[]string{"provider", "chain", "field", "region"},
	)
	prometheus.MustRegister(metadataCoverageSuccess)

	// Metadata API latency
	metadataAPILatency = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "metadata_api_latency_milliseconds",
			Help:    "Metadata API response latency in milliseconds",
			Buckets: []float64{50, 100, 200, 500, 1000, 2000, 5000, 10000},
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(metadataAPILatency)

	// Head lag - milliseconds behind (raw value)
	headLagBlocks = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "head_lag_milliseconds",
			Help: "Indexation latency in milliseconds (time between on-chain event and WebSocket receipt)",
		},
		[]string{"aggregator", "chain", "region"},
	)
	prometheus.MustRegister(headLagBlocks)

	// Head lag - seconds behind (converted from ms)
	headLagSeconds = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "head_lag_seconds",
			Help: "Indexation latency in seconds (time between on-chain event and WebSocket receipt)",
		},
		[]string{"aggregator", "chain", "region"},
	)
	prometheus.MustRegister(headLagSeconds)

	// Companion to head_lag_seconds, measured against our own node
	// subscription instead of the timestamp each provider sends us. Same
	// labels so the two are directly comparable. See reference_monitor.go
	// for why the legacy series cannot be trusted as an absolute number.
	headLagRefSeconds = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "head_lag_ref_seconds",
			Help: "Indexation latency in seconds, measured from a node subscription we hold ourselves, matched by transaction hash.",
		},
		[]string{"aggregator", "chain", "region"},
	)
	prometheus.MustRegister(headLagRefSeconds)

	// How many provider emissions we could and could not match against the
	// reference clock. A high miss rate means the reference subscription is
	// lagging or disconnected and the ref series must not be trusted.
	headLagRefMatches = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "head_lag_ref_matches_total",
			Help: "Provider trade emissions matched against the node reference clock, by outcome.",
		},
		[]string{"aggregator", "chain", "region", "outcome"},
	)
	prometheus.MustRegister(headLagRefMatches)

	refClockEntries = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "head_lag_ref_clock_entries",
			Help: "Transactions currently held in the reference clock window.",
		},
	)
	prometheus.MustRegister(refClockEntries)

	// Blockchain head block number (source of truth)
	blockchainHead = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "blockchain_head_block",
			Help: "Latest block number on the blockchain (source of truth)",
		},
		[]string{"chain", "region"},
	)
	prometheus.MustRegister(blockchainHead)

	// Aggregator head block number (what they have indexed)
	aggregatorHead = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "aggregator_head_block",
			Help: "Latest block number indexed by the aggregator",
		},
		[]string{"aggregator", "chain", "region"},
	)
	prometheus.MustRegister(aggregatorHead)

	// Head lag errors counter
	headLagErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "head_lag_errors_total",
			Help: "Total number of errors when fetching head lag data",
		},
		[]string{"aggregator", "chain", "error_type", "region"},
	)
	prometheus.MustRegister(headLagErrors)

	// Fast-trade latency (separate from head_lag for comparison)
	fastTradeLatency = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "fast_trade_latency_milliseconds",
			Help: "Fast-trade WebSocket latency in milliseconds (for comparison with Pulse V2)",
		},
		[]string{"aggregator", "chain", "region"},
	)
	prometheus.MustRegister(fastTradeLatency)

	// Mobula head lag detailed (fixed-cardinality; breakdown exposed as separate gauges)
	mobulaHeadLagDetailed = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "mobula_head_lag_detailed_seconds",
			Help: "Mobula total head lag in seconds (on-chain -> WebSocket receipt)",
		},
		[]string{"aggregator", "chain", "region", "pool_address"},
	)
	prometheus.MustRegister(mobulaHeadLagDetailed)

	mobulaProcessingLagSeconds = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "mobula_processing_lag_seconds",
			Help: "Mobula processing latency (on-chain -> Mobula processed)",
		},
		[]string{"aggregator", "chain", "region", "pool_address"},
	)
	prometheus.MustRegister(mobulaProcessingLagSeconds)

	mobulaNetworkLagSeconds = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "mobula_network_lag_seconds",
			Help: "Network latency Mobula processed -> WebSocket receipt",
		},
		[]string{"aggregator", "chain", "region", "pool_address"},
	)
	prometheus.MustRegister(mobulaNetworkLagSeconds)

	// Gauge value is always 1; tx_hash is carried as a label so alert templates
	// can query the latest tx per pool. Exactly ONE series per (chain, pool_address)
	// is kept alive at any time — see RecordMobulaLastTx for the delete/set dance.
	mobulaLastTxHash = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "mobula_last_tx_hash",
			Help: "Latest Mobula trade tx_hash per pool (value=1, tx_hash label rotated)",
		},
		[]string{"aggregator", "chain", "region", "pool_address", "tx_hash"},
	)
	prometheus.MustRegister(mobulaLastTxHash)

	wsReconnects = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ws_reconnects_total",
			Help: "Total number of WebSocket reconnections per aggregator (increments on every disconnect, whatever the cause)",
		},
		[]string{"aggregator", "region"},
	)
	prometheus.MustRegister(wsReconnects)

	wsConnected = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ws_connected",
			Help: "WebSocket connection state per aggregator (1 = connected, 0 = disconnected)",
		},
		[]string{"aggregator", "region"},
	)
	prometheus.MustRegister(wsConnected)
}

// RecordWSReconnect increments the reconnect counter for an aggregator's WebSocket.
func RecordWSReconnect(aggregator string, region string) {
	wsReconnects.WithLabelValues(aggregator, region).Inc()
}

// DeleteHeadLagSeries removes the head-lag gauges for one (aggregator,
// chain, region) so a dead subscription cannot keep publishing its last
// value (frozen-gauge trap, Codex Solana 2026-07-09).
func DeleteHeadLagSeries(aggregator, chain, region string) {
	headLagSeconds.DeleteLabelValues(aggregator, chain, region)
	headLagBlocks.DeleteLabelValues(aggregator, chain, region)
}

// RecordWSConnected sets the connection state gauge for an aggregator's WebSocket.
func RecordWSConnected(aggregator string, region string, connected bool) {
	v := 0.0
	if connected {
		v = 1.0
	}
	wsConnected.WithLabelValues(aggregator, region).Set(v)
}

// RecordMobulaLastTx overwrites the single live series for (chain, pool_address)
// with a new tx_hash label. Prevents cardinality leak by deleting the previous
// label set before setting the new one.
func RecordMobulaLastTx(chain, region, poolAddress, txHash string) {
	if txHash == "" {
		return
	}
	key := chain + ":" + poolAddress
	mobulaLastTxMu.Lock()
	defer mobulaLastTxMu.Unlock()

	if prev, ok := mobulaLastTxSeen[key]; ok && prev != txHash {
		mobulaLastTxHash.DeleteLabelValues("mobula", chain, region, poolAddress, prev)
	}
	mobulaLastTxHash.WithLabelValues("mobula", chain, region, poolAddress, txHash).Set(1)
	mobulaLastTxSeen[key] = txHash
}

func RecordPoolDiscoveryLatency(aggregator string, chain string, latencyMs float64, region string) {
	// Filter out invalid values: negative or > 2 minutes (120000ms)
	if latencyMs < 0 || latencyMs > 120000 {
		return
	}

	poolDiscoveryLatency.WithLabelValues(aggregator, chain, region).Set(latencyMs)
}

// RecordPoolDiscoveryError records an error when fetching pool discovery data
func RecordPoolDiscoveryError(aggregator string, errorType string, region string) {
	poolDiscoveryErrors.WithLabelValues(aggregator, errorType, region).Inc()
}

// RecordRESTLatency records the latency of a REST API call
func RecordRESTLatency(aggregator string, endpoint string, chain string, latencyMs float64, statusCode int, region string) {
	// Record latency in histogram
	restAPILatency.WithLabelValues(aggregator, endpoint, chain, region).Observe(latencyMs)

	// Record status code
	restAPIStatusCodes.WithLabelValues(aggregator, endpoint, chain, fmt.Sprintf("%d", statusCode), region).Inc()
}

// RecordRESTError records a REST API error
func RecordRESTError(aggregator string, endpoint string, chain string, errorType string, region string) {
	restAPIErrors.WithLabelValues(aggregator, endpoint, chain, errorType, region).Inc()
}

// RecordQuoteAPILatency records the latency of a Quote API call
func RecordQuoteAPILatency(provider string, chain string, latencyMs float64, statusCode int, region string) {
	// Record latency in histogram
	quoteAPILatency.WithLabelValues(provider, chain, region).Observe(latencyMs)

	// Record status code
	quoteAPIStatusCodes.WithLabelValues(provider, chain, fmt.Sprintf("%d", statusCode), region).Inc()
}

// RecordQuoteAPIError records a Quote API error
func RecordQuoteAPIError(provider string, chain string, errorType string, region string) {
	quoteAPIErrors.WithLabelValues(provider, chain, errorType, region).Inc()
}

// RecordMetadataCoverage records metadata coverage for a specific field
func RecordMetadataCoverage(provider string, chain string, field string, present bool, region string) {
	metadataCoverageTotal.WithLabelValues(provider, chain, field, region).Inc()
	if present {
		metadataCoverageSuccess.WithLabelValues(provider, chain, field, region).Inc()
	}
}

// RecordMetadataLatency records the latency of a metadata API call
func RecordMetadataLatency(provider string, chain string, latencyMs float64, region string) {
	metadataAPILatency.WithLabelValues(provider, chain, region).Observe(latencyMs)
}

// RecordHeadLag records the head lag for an aggregator on a specific chain
func RecordHeadLag(aggregator string, chain string, lagBlocks int64, lagSeconds float64, region string, txHash string) {
	// Filter out aberrant values. 120s matches the fast-trade filter: it
	// keeps out reconnect replay backlogs (minutes-old events redelivered
	// after a resubscribe) while letting real high lag through. The old 30s
	// cap silently dropped every codex sample on Robinhood Chain (~45s real
	// lag), showing "no data" instead of the honest bad number.
	if lagSeconds < 0 || lagSeconds > 120 {
		return
	}

	headLagBlocks.WithLabelValues(aggregator, chain, region).Set(float64(lagBlocks))
	headLagSeconds.WithLabelValues(aggregator, chain, region).Set(lagSeconds)
	// tx_hash is logged but not stored as a metric label to avoid cardinality explosion
}

// RecordHeadLagRef records head lag measured against our own node
// subscription. Only called when the trade was actually seen by the
// reference clock; an unmatched emission is counted as a miss and
// deliberately produces no lag value, because falling back to the
// provider's own timestamp is the defect this series exists to remove.
//
// The value is SIGNED and negatives are kept. Validated end to end
// before shipping, on trades matched by hash at a 100% match rate:
// against public endpoints (publicnode on Base, mainnet-beta on Solana)
// Mobula delivers the trade BEFORE our subscription sees it, p50 -1.20 s
// on Base and -0.32 s on Solana. That is not a provider being fast
// enough to time travel, it is the public node being slower than the
// provider's pipeline.
//
// The consequence for how this series must be read: the reference node's
// own latency sits in every sample as a roughly constant offset, so the
// ABSOLUTE number is not a head lag. The RELATIVE comparison is sound,
// because every provider is measured against the same clock on the same
// transaction, which is exactly what the legacy series cannot claim
// (measured: the legacy method is off by 1,946 ms on Base and 331 ms on
// Solana versus this one). Point REF_WS_URL_<CHAIN> at a paid or
// colocated node to collapse the offset and make the absolute number
// meaningful too.
func RecordHeadLagRef(aggregator, chain string, lagSeconds float64, region string) {
	if lagSeconds > 120 || lagSeconds < -120 {
		headLagRefMatches.WithLabelValues(aggregator, chain, region, "out_of_range").Inc()
		return
	}
	outcome := "matched"
	if lagSeconds < 0 {
		outcome = "ahead_of_reference"
	}
	headLagRefMatches.WithLabelValues(aggregator, chain, region, outcome).Inc()
	headLagRefSeconds.WithLabelValues(aggregator, chain, region).Set(lagSeconds)
}

// RecordHeadLagRefMiss counts a provider emission the reference clock
// never saw, so the match rate is auditable from the metrics alone.
func RecordHeadLagRefMiss(aggregator, chain, region string) {
	headLagRefMatches.WithLabelValues(aggregator, chain, region, "unmatched").Inc()
}

// RecordRefClockSize publishes the reference window occupancy.
func RecordRefClockSize(n int) { refClockEntries.Set(float64(n)) }

// RecordBlockchainHead records the current blockchain head block number
func RecordBlockchainHead(chain string, blockNumber int64, region string) {
	blockchainHead.WithLabelValues(chain, region).Set(float64(blockNumber))
}

// RecordAggregatorHead records the aggregator's indexed head block number
func RecordAggregatorHead(aggregator string, chain string, blockNumber int64, region string) {
	aggregatorHead.WithLabelValues(aggregator, chain, region).Set(float64(blockNumber))
}

// RecordHeadLagError records an error when fetching head lag data
func RecordHeadLagError(aggregator string, chain string, errorType string, region string) {
	headLagErrors.WithLabelValues(aggregator, chain, errorType, region).Inc()
}

// RecordCodexBlockNumber records the block number from Codex events
func RecordCodexBlockNumber(chain string, blockNumber int64, region string) {
	aggregatorHead.WithLabelValues("codex", chain, region).Set(float64(blockNumber))
}

// RecordFastTradeLatency records fast-trade WebSocket latency
func RecordFastTradeLatency(aggregator string, chain string, latencyMs float64, region string) {
	// Filter out invalid values
	if latencyMs < 0 || latencyMs > 120000 {
		return
	}
	fastTradeLatency.WithLabelValues(aggregator, chain, region).Set(latencyMs)
}

// RecordMobulaHeadLagDetailed records Mobula head lag with breakdown on fixed-cardinality gauges
func RecordMobulaHeadLagDetailed(
	chain string,
	region string,
	poolAddress string,
	txHash string,
	totalLagMs int64,
	mobulaProcessingMs int64,
	networkLatencyMs int64,
	onChainTime string,
	mobulaTime string,
	receivedTime string,
) {
	// Drop replays/clock-skew: > 30s is not a real indexation latency
	if totalLagMs < 0 || totalLagMs > 30000 {
		return
	}

	mobulaHeadLagDetailed.WithLabelValues("mobula", chain, region, poolAddress).
		Set(float64(totalLagMs) / 1000.0)
	mobulaProcessingLagSeconds.WithLabelValues("mobula", chain, region, poolAddress).
		Set(float64(mobulaProcessingMs) / 1000.0)
	mobulaNetworkLagSeconds.WithLabelValues("mobula", chain, region, poolAddress).
		Set(float64(networkLatencyMs) / 1000.0)
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()

	// Prometheus metrics endpoint
	mux.Handle("/metrics", promhttp.Handler())

	// Admin cleanup endpoint
	setupCleanupEndpoint(mux)

	// Debug: tail of in-memory log ring (shared loghub package)
	mux.Handle("/logs", logsHandler())

	return http.ListenAndServe(addr, mux)
}
