package main

import (
	"fmt"
	"net/http"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
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
	headLagBlocks      *prometheus.GaugeVec
	headLagSeconds     *prometheus.GaugeVec
	blockchainHead     *prometheus.GaugeVec
	aggregatorHead     *prometheus.GaugeVec
	headLagErrors      *prometheus.CounterVec

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
	// Filter out aberrant values (> 30s likely means connection issues, not real lag)
	if lagSeconds < 0 || lagSeconds > 30 {
		return
	}

	headLagBlocks.WithLabelValues(aggregator, chain, region).Set(float64(lagBlocks))
	headLagSeconds.WithLabelValues(aggregator, chain, region).Set(lagSeconds)
	// tx_hash is logged but not stored as a metric label to avoid cardinality explosion
}

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

	// Debug: tail of in-memory log ring
	setupLogsEndpoint(mux)

	// Debug: last N Codex GraphQL calls (status, body sample, JWT state)
	setupCodexDebugEndpoint(mux)

	return http.ListenAndServe(addr, mux)
}
