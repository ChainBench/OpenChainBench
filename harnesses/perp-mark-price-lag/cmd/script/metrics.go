package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	deviationGauge       *prometheus.GaugeVec
	deviationSignedGauge *prometheus.GaugeVec
	refPriceGauge        *prometheus.GaugeVec
	markPriceGauge       *prometheus.GaugeVec
	healthGauge          *prometheus.GaugeVec
	fetchLatencyGauge    *prometheus.GaugeVec
	fetchErrorsCtr       *prometheus.CounterVec
	lastRefreshGauge     *prometheus.GaugeVec
)

func init() {
	deviationGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_mark_deviation_bps",
		Help: "Absolute deviation between venue mark price and Binance spot reference, in bps.",
	}, []string{"venue", "chain"})
	prometheus.MustRegister(deviationGauge)

	deviationSignedGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_mark_deviation_signed_bps",
		Help: "Signed deviation (mark - reference) / reference x 10000. Positive = mark above reference.",
	}, []string{"venue", "chain"})
	prometheus.MustRegister(deviationSignedGauge)

	refPriceGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_mark_reference_price_usd",
		Help: "Binance spot mid used as reference price, in USD.",
	}, []string{"chain"})
	prometheus.MustRegister(refPriceGauge)

	markPriceGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_mark_price_usd",
		Help: "Venue mark price used for deviation computation, in USD.",
	}, []string{"venue", "chain"})
	prometheus.MustRegister(markPriceGauge)

	healthGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_mark_health",
		Help: "1 if the last sample for this venue x asset succeeded, 0 if errored.",
	}, []string{"venue", "chain"})
	prometheus.MustRegister(healthGauge)

	fetchLatencyGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_mark_fetch_latency_milliseconds",
		Help: "Wall-clock time of the last sample fetch, in milliseconds.",
	}, []string{"venue", "chain"})
	prometheus.MustRegister(fetchLatencyGauge)

	fetchErrorsCtr = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "perp_mark_fetch_errors_total",
		Help: "Total fetch failures per venue and asset.",
	}, []string{"venue", "chain", "error_type"})
	prometheus.MustRegister(fetchErrorsCtr)

	lastRefreshGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_mark_last_refresh_timestamp_seconds",
		Help: "Unix timestamp of the last successful sample.",
	}, []string{"venue", "chain"})
	prometheus.MustRegister(lastRefreshGauge)
}

func recordSample(s MarkSample) {
	if s.Err != "" {
		errorType := classifyErr(s.Err)
		fetchErrorsCtr.WithLabelValues(s.Venue, s.Asset, errorType).Inc()
		healthGauge.WithLabelValues(s.Venue, s.Asset).Set(0)
		return
	}
	deviationGauge.WithLabelValues(s.Venue, s.Asset).Set(s.DeviationBps)
	deviationSignedGauge.WithLabelValues(s.Venue, s.Asset).Set(s.SignedBps)
	markPriceGauge.WithLabelValues(s.Venue, s.Asset).Set(s.MarkPrice)
	refPriceGauge.WithLabelValues(s.Asset).Set(s.RefPrice)
	healthGauge.WithLabelValues(s.Venue, s.Asset).Set(1)
	fetchLatencyGauge.WithLabelValues(s.Venue, s.Asset).Set(float64(s.FetchLatMs))
	lastRefreshGauge.WithLabelValues(s.Venue, s.Asset).Set(float64(nowUnix()))
}

func classifyErr(err string) string {
	switch {
	case contains(err, "timeout") || contains(err, "context deadline"):
		return "timeout"
	case contains(err, "status_429") || contains(err, "rate"):
		return "rate_limit"
	case contains(err, "status_5"):
		return "server_error"
	case contains(err, "not_found") || contains(err, "404"):
		return "not_found"
	default:
		return "other"
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsRune(s, sub))
}

func containsRune(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// StartMetricsServer starts the Prometheus /metrics endpoint on addr.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})
	return http.ListenAndServe(addr, mux)
}
