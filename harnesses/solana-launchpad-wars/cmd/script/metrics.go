package main

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	launchpadVol24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "solana_launchpad_volume_24h_usd",
		Help: "24h trading volume in USD (Mobula lighthouse byLaunchpad).",
	}, []string{"launchpad"})

	launchpadFees24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "solana_launchpad_fees_24h_usd",
		Help: "24h protocol fees in USD (Mobula lighthouse byLaunchpad).",
	}, []string{"launchpad"})

	launchpadTrades24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "solana_launchpad_trades_24h",
		Help: "24h trade count (Mobula lighthouse byLaunchpad).",
	}, []string{"launchpad"})

	launchpadHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "solana_launchpad_health",
		Help: "1 if this launchpad returned data in the last lighthouse poll.",
	}, []string{"launchpad"})

	platformVol24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "solana_platform_volume_24h_usd",
		Help: "24h trading volume in USD routed through this Solana trading platform.",
	}, []string{"platform"})

	platformFees24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "solana_platform_fees_24h_usd",
		Help: "24h platform fees in USD collected by this Solana trading platform.",
	}, []string{"platform"})

	platformHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "solana_platform_health",
		Help: "1 if this platform returned data in the last lighthouse poll.",
	}, []string{"platform"})
)

func init() {
	prometheus.MustRegister(
		launchpadVol24h,
		launchpadFees24h,
		launchpadTrades24h,
		launchpadHealth,
		platformVol24h,
		platformFees24h,
		platformHealth,
	)
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	s := strings.ToLower(name)
	s = nonAlnum.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

func publishLighthouse(data *lighthouseData) {
	for _, e := range data.ByLaunchpad {
		slug := slugify(e.Name)
		launchpadVol24h.WithLabelValues(slug).Set(e.VolumeUSD.H24)
		launchpadFees24h.WithLabelValues(slug).Set(e.FeesPaidUSD.H24)
		launchpadTrades24h.WithLabelValues(slug).Set(e.Trades.H24)
		launchpadHealth.WithLabelValues(slug).Set(1)
	}
	for _, e := range data.ByPlatform {
		slug := slugify(e.Name)
		platformVol24h.WithLabelValues(slug).Set(e.VolumeUSD.H24)
		platformFees24h.WithLabelValues(slug).Set(e.FeesPaidUSD.H24)
		platformHealth.WithLabelValues(slug).Set(1)
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
