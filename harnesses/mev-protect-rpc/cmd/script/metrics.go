package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// Headline gauge: median latency across the wallet methods the
	// provider served this tick. quantile_over_time in the spec turns
	// it into the 24h p50/p90/p99 columns.
	mevWalletLatency = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "mev_rpc_wallet_latency_milliseconds",
		Help: "Median latency across the wallet method set served this tick, per MEV-protect provider.",
	}, []string{"provider", "region"})

	mevWalletLatencyHist = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "mev_rpc_wallet_latency_milliseconds_histogram",
		Help:    "Distribution of per-tick median wallet latency.",
		Buckets: prometheus.ExponentialBuckets(25, 2, 10),
	}, []string{"provider", "region"})

	mevMethodLatency = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "mev_rpc_method_latency_milliseconds",
		Help: "Latency of the last successful call per method.",
	}, []string{"provider", "method", "region"})

	mevMethodOK = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "mev_rpc_method_ok",
		Help: "1 when the method succeeded on the last tick, 0 otherwise.",
	}, []string{"provider", "method", "region"})

	mevMethodsSupported = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "mev_rpc_methods_supported",
		Help: "Count of wallet methods served on the last tick (max 7).",
	}, []string{"provider", "region"})

	mevCallTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "mev_rpc_call_total",
		Help: "Probe outcomes per provider/method.",
	}, []string{"provider", "method", "region", "result"})
)
