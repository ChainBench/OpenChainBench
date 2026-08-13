package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	feeRatePct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "memecoin_platform_fee_rate_pct",
		Help: "Take rate using Mobula total volume: fees_usd_24h / mobula_volume_usd_24h * 100 (lower bound; denominator includes non-fee trades)",
	}, []string{"platform"})

	feePayingRatePct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "memecoin_platform_fee_paying_rate_pct",
		Help: "Take rate using fee-paying volume only: fees_usd_24h / fee_paying_volume_usd_24h * 100 (comparable across platforms)",
	}, []string{"platform"})

	coveragePct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "memecoin_platform_coverage_pct",
		Help: "Fee-paying volume / Mobula total volume * 100: fraction of attributed volume that generated a fee inflow",
	}, []string{"platform"})

	feesUSD24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "memecoin_platform_fees_usd_24h",
		Help: "Raw USD fees collected by this platform in the last 24h (Dune)",
	}, []string{"platform"})

	volumeUSD24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "memecoin_platform_volume_usd_24h",
		Help: "Trading volume in USD in the last 24h (Mobula lighthouse, total attributed volume)",
	}, []string{"platform"})

	feePayingVolumeUSD24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "memecoin_platform_fee_paying_volume_usd_24h",
		Help: "Volume of trades that generated a fee inflow in the last 24h (Dune: largest swap per fee-receiving tx)",
	}, []string{"platform"})

	platformHealth = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "memecoin_platform_health",
		Help: "1.0 when both Dune and lighthouse data are fresh",
	})

	lastPollTime = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "memecoin_last_poll_timestamp_seconds",
		Help: "Unix timestamp of the last successful poll",
	})

	duneDataFreshness = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "memecoin_dune_data_freshness_seconds",
		Help: "Unix timestamp of the most recent block_time seen in the Dune query results. Gap from now() indicates solana.account_activity table lag.",
	})
)

func init() {
	prometheus.MustRegister(
		feeRatePct, feePayingRatePct, coveragePct,
		feesUSD24h, volumeUSD24h, feePayingVolumeUSD24h,
		platformHealth, lastPollTime, duneDataFreshness,
	)
}

func startMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	return http.ListenAndServe(addr, mux)
}
