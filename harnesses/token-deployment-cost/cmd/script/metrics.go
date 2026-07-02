package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics emitted per chain:
//
//   token_deployment_cost_usd{chain, layer, kind}
//     Live USD cost to bring a fungible token into existence on this chain
//     using its canonical/most-used method. Lower is better.
//
//   token_deployment_cost_native{chain, layer, kind, unit}
//     Same cost but in the chain's native unit (wei, lamports, ada, etc.)
//     for transparency. `unit` is the human-readable unit name.
//
//   token_deployment_gas_units{chain, layer, kind}
//     Gas/compute units the deployment consumes. NaN for non-gas chains
//     where the cost is a fixed protocol param (Stellar base reserve,
//     Cosmos denom_creation_fee, Cardano min-UTxO).
//
//   token_deployment_native_price_usd{chain}
//     Current Mobula USD price of the chain's native token. Diagnostic.
//
//   token_deployment_sample_duration_seconds{chain}
//     Latency of the last sample cycle for the chain.
//
//   token_deployment_samples_total{chain, status}
//     Cumulative counter of samples, by status=ok|error.

var (
	costUSD       *prometheus.GaugeVec
	costNative    *prometheus.GaugeVec
	gasUnits      *prometheus.GaugeVec
	nativePrice   *prometheus.GaugeVec
	sampleLatency *prometheus.GaugeVec
	samplesTotal  *prometheus.CounterVec
)

func init() {
	costUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_deployment_cost_usd",
		Help: "Live USD cost to create a fungible token on this chain using its canonical method (lower is better).",
	}, []string{"chain", "layer", "kind"})
	prometheus.MustRegister(costUSD)

	costNative = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_deployment_cost_native",
		Help: "Token-creation cost in the chain's native unit.",
	}, []string{"chain", "layer", "kind", "unit"})
	prometheus.MustRegister(costNative)

	gasUnits = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_deployment_gas_units",
		Help: "Gas / compute units consumed by the canonical deployment (NaN for protocol-fee chains).",
	}, []string{"chain", "layer", "kind"})
	prometheus.MustRegister(gasUnits)

	nativePrice = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_deployment_native_price_usd",
		Help: "USD price of the chain's native token sourced from Mobula.",
	}, []string{"chain"})
	prometheus.MustRegister(nativePrice)

	sampleLatency = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_deployment_sample_duration_seconds",
		Help: "Wall-clock seconds the last sample cycle took for this chain.",
	}, []string{"chain"})
	prometheus.MustRegister(sampleLatency)

	samplesTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "token_deployment_samples_total",
		Help: "Total sample cycles per chain, broken down by status.",
	}, []string{"chain", "status"})
	prometheus.MustRegister(samplesTotal)
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
