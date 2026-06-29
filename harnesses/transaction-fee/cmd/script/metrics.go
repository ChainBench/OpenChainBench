package main

import (
	"net/http"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// FeeSample is one snapshot of a chain's native-transfer fee.
//
// NativeFee is in the chain's smallest unit (wei, lamport, lovelace, stroop,
// satoshi, atomic units, sun, …) so we don't lose precision in float math.
// UsdFee is computed at scrape time using the latest Mobula price.
type FeeSample struct {
	Chain     string
	Tier      string // "slow" | "std" | "fast" | "single"
	NativeFee float64
	UsdFee    float64
	GasPrice  float64 // optional, EVM only — gwei
	Err       string
}

var (
	feeUSDGauge      *prometheus.GaugeVec
	feeNativeGauge   *prometheus.GaugeVec
	gasPriceGauge    *prometheus.GaugeVec
	priceUSDGauge    *prometheus.GaugeVec
	lastRefreshGauge *prometheus.GaugeVec
	fetchErrors      *prometheus.CounterVec
	healthOK         *prometheus.GaugeVec
)

func init() {
	feeUSDGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "tx_fee_native_transfer_usd",
			Help: "Current cost in USD of a standard native-token transfer on the chain. Lower = cheaper.",
		},
		[]string{"chain", "tier", "layer"},
	)
	prometheus.MustRegister(feeUSDGauge)

	feeNativeGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "tx_fee_native_transfer_native",
			Help: "Current cost in the chain's native smallest unit (wei, lamport, lovelace, satoshi, etc.).",
		},
		[]string{"chain", "tier", "layer"},
	)
	prometheus.MustRegister(feeNativeGauge)

	gasPriceGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "tx_fee_gas_price_gwei",
			Help: "Gas price in gwei (EVM chains only). Decomposes the USD headline.",
		},
		[]string{"chain", "tier", "layer"},
	)
	prometheus.MustRegister(gasPriceGauge)

	priceUSDGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "tx_fee_native_token_price_usd",
			Help: "USD price of the chain's native token used for the current sample.",
		},
		[]string{"chain", "layer"},
	)
	prometheus.MustRegister(priceUSDGauge)

	lastRefreshGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "tx_fee_last_refresh_timestamp_seconds",
			Help: "Unix timestamp of the last successful sample per chain.",
		},
		[]string{"chain", "layer"},
	)
	prometheus.MustRegister(lastRefreshGauge)

	fetchErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "tx_fee_fetch_errors_total",
			Help: "Total fetch failures per chain, by error type.",
		},
		[]string{"chain", "error_type", "layer"},
	)
	prometheus.MustRegister(fetchErrors)

	healthOK = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "tx_fee_health",
			Help: "1 if the chain produced a fresh sample in the last refresh, 0 otherwise.",
		},
		[]string{"chain", "layer"},
	)
	prometheus.MustRegister(healthOK)
}

var (
	lastPrices   = make(map[string]float64)
	lastPricesMu sync.RWMutex
)

func setPrice(slug string, p float64) {
	lastPricesMu.Lock()
	lastPrices[slug] = p
	lastPricesMu.Unlock()
	// The Prom gauge is now per-chain (chain+layer labels) and emitted from
	// runChainLoop where we know the chain identity; here we only update the
	// in-memory cache keyed by Mobula slug.
}

func getPrice(slug string) float64 {
	lastPricesMu.RLock()
	defer lastPricesMu.RUnlock()
	return lastPrices[slug]
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
