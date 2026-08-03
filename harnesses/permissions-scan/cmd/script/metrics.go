package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	worstCaseHoursGauge    *prometheus.GaugeVec
	settlementAgeSecsGauge *prometheus.GaugeVec
	settlementAgeHrsGauge  *prometheus.GaugeVec
	settlementCallableGauge *prometheus.GaugeVec
	lastSettlementIDGauge  *prometheus.GaugeVec
	epochNumberGauge       *prometheus.GaugeVec
	epochAgeHrsGauge       *prometheus.GaugeVec
)

func init() {
	worstCaseHoursGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_exit_worst_case_hours",
		Help: "Worst-case hours to withdraw without operator help. 999999 = no permissionless path.",
	}, []string{"venue"})
	prometheus.MustRegister(worstCaseHoursGauge)

	settlementAgeSecsGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_exit_settlement_age_seconds",
		Help: "Seconds since last OstiumVault settlement (live RPC).",
	}, []string{"venue"})
	prometheus.MustRegister(settlementAgeSecsGauge)

	settlementAgeHrsGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_exit_settlement_age_hours",
		Help: "Hours since last OstiumVault settlement (live RPC).",
	}, []string{"venue"})
	prometheus.MustRegister(settlementAgeHrsGauge)

	settlementCallableGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_exit_settlement_callable",
		Help: "1 if tryNewSettlement() is callable on OstiumVault right now, 0 otherwise.",
	}, []string{"venue"})
	prometheus.MustRegister(settlementCallableGauge)

	lastSettlementIDGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_exit_last_settlement_id",
		Help: "Most recent settlement ID from OstiumVault (live RPC).",
	}, []string{"venue"})
	prometheus.MustRegister(lastSettlementIDGauge)

	epochNumberGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_exit_epoch_number",
		Help: "Current gToken epoch number from gains.trade gDAI vault (live RPC).",
	}, []string{"venue"})
	prometheus.MustRegister(epochNumberGauge)

	epochAgeHrsGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_exit_epoch_age_hours",
		Help: "Hours since the current gains.trade epoch started (live RPC).",
	}, []string{"venue"})
	prometheus.MustRegister(epochAgeHrsGauge)
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("OK"))
	})
	return http.ListenAndServe(addr, mux)
}
