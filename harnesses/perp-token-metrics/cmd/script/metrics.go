package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var labels = []string{"protocol"}

func gauge(name, help string) *prometheus.GaugeVec {
	return prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: name, Help: help}, labels)
}

var (
	// Bench 234 gauges (names unchanged so the live spec keeps resolving).
	protocolPE        = gauge("perp_protocol_pe_ratio", "P/E ratio per perp DEX protocol (FDV / annualized 30d revenue).")
	protocolFDV       = gauge("perp_protocol_fdv_usd", "Fully diluted valuation in USD (CoinGecko; market cap when FDV is unknown).")
	protocolAnnualRev = gauge("perp_protocol_annual_rev_usd", "Annualized protocol revenue in USD (DeFiLlama dailyRevenue, trailing 30d x 365/30).")
	protocolRev24h    = gauge("perp_protocol_rev_24h_usd", "24h protocol revenue in USD (DeFiLlama dailyRevenue).")
	protocolHealth    = gauge("perp_protocol_health", "1 if this protocol returned fee data in the last poll.")

	// Valuation gauges (P/F page).
	protocolFees24h     = gauge("perp_protocol_fees_24h_usd", "24h total fees paid by users in USD (DeFiLlama dailyFees, token scope).")
	protocolFees30d     = gauge("perp_protocol_fees_30d_usd", "Trailing 30d fees in USD (DeFiLlama dailyFees, token scope).")
	protocolFeesPrev30d = gauge("perp_protocol_fees_prev_30d_usd", "Fees in USD for days 31-60 back, for month-over-month trend.")
	protocolFees1y      = gauge("perp_protocol_fees_1y_usd", "Trailing 365d fees in USD.")
	protocolAnnualFees  = gauge("perp_protocol_annual_fees_usd", "Annualized fees in USD (trailing 30d x 365/30).")
	protocolPerpFees30d = gauge("perp_protocol_perp_fees_30d_usd", "Trailing 30d fees of the perps product only, in USD (equals fees_30d for single-product protocols).")
	protocolRev30d      = gauge("perp_protocol_rev_30d_usd", "Trailing 30d protocol revenue in USD (DeFiLlama dailyRevenue).")
	protocolRevShare    = gauge("perp_protocol_rev_share_pct", "Share of 30d fees that is protocol revenue, in percent.")

	protocolMcap  = gauge("perp_protocol_mcap_usd", "Circulating market cap in USD (CoinGecko).")
	protocolFloat = gauge("perp_protocol_float_pct", "Circulating supply as a percent of total supply (CoinGecko).")

	protocolPF    = gauge("perp_protocol_pf_ratio", "Price-to-fees: market cap / annualized fees.")
	protocolPFfdv = gauge("perp_protocol_pf_fdv_ratio", "FDV-to-fees: fully diluted valuation / annualized fees.")
	protocolPS    = gauge("perp_protocol_ps_ratio", "Price-to-sales: market cap / annualized protocol revenue.")

	protocolOI       = gauge("perp_protocol_oi_usd", "Open interest in USD on the perps product (DeFiLlama open-interest overview).")
	protocolFeesToOI = gauge("perp_protocol_fees_to_oi_ratio", "Annualized fees / open interest: how hard the book is worked per dollar of OI.")
)

func init() {
	prometheus.MustRegister(
		protocolPE, protocolFDV, protocolAnnualRev, protocolRev24h, protocolHealth,
		protocolFees24h, protocolFees30d, protocolFeesPrev30d, protocolFees1y, protocolAnnualFees,
		protocolPerpFees30d, protocolRev30d, protocolRevShare,
		protocolMcap, protocolFloat,
		protocolPF, protocolPFfdv, protocolPS,
		protocolOI, protocolFeesToOI,
	)
}

func labelsFor(slug string) prometheus.Labels {
	return prometheus.Labels{"protocol": slug}
}

// setOrDelete publishes v when defined, otherwise removes the series so a
// stale value from an earlier poll cannot outlive the data that produced it.
func setOrDelete(g *prometheus.GaugeVec, l prometheus.Labels, v float64, defined bool) {
	if defined {
		g.With(l).Set(v)
		return
	}
	g.Delete(l)
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
