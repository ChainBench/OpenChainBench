package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	platformVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_volume_24h_usd",
		Help: "24h trading volume in USD per platform, summed across all blockchains (Dune community datasets).",
	}, []string{"platform"})

	platformTxns = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_txns_24h",
		Help: "24h swap transaction count per platform, summed across all blockchains (Dune community datasets).",
	}, []string{"platform"})

	platformFeesUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_fees_24h_usd",
		Help: "24h protocol fee revenue in USD per platform, summed across all blockchains (Dune community datasets).",
	}, []string{"platform"})

	platformAvgTrade = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_avg_trade_usd",
		Help: "Average swap size in USD per platform (volume_usd / txns, Dune community datasets).",
	}, []string{"platform"})

	platformFeeRate = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_fee_rate_pct",
		Help: "Observed fee take rate in percent per platform (fees_usd / volume_usd * 100, Dune community datasets).",
	}, []string{"platform"})

	platformHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_volume_health",
		Help: "1 if this platform returned data in the last Dune poll.",
	}, []string{"platform"})
)

func init() {
	prometheus.MustRegister(
		platformVolume,
		platformTxns,
		platformFeesUSD,
		platformAvgTrade,
		platformFeeRate,
		platformHealth,
	)
}

func publishRows(rows []duneRow) {
	for _, r := range rows {
		if r.Platform == "" {
			continue
		}
		platformVolume.WithLabelValues(r.Platform).Set(r.VolumeUSD)
		platformTxns.WithLabelValues(r.Platform).Set(r.Txns)
		platformFeesUSD.WithLabelValues(r.Platform).Set(r.FeesUSD)
		if r.AvgTradeUSD > 0 {
			platformAvgTrade.WithLabelValues(r.Platform).Set(r.AvgTradeUSD)
		}
		platformFeeRate.WithLabelValues(r.Platform).Set(r.FeeRatePct)
		platformHealth.WithLabelValues(r.Platform).Set(1)
	}
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
