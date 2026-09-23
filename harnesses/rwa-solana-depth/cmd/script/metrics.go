package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// Headline family: cost of selling the size, relative to a $100 sale
	// of the same asset on the same tick, in basis points. Positive is a
	// worse price at size (the normal case); a routed asset whose quote
	// failed at a size has that child deleted, never a stale value.
	depthCost = map[string]*prometheus.GaugeVec{}

	depthFill = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_depth_fill_usd_100k",
		Help: "USDC proceeds of selling $100,000 worth of the asset (at the $100 quote price) on Jupiter, this tick.",
	}, []string{"asset", "issuer"})

	depthRouteOK = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_depth_route_ok",
		Help: "1 when Jupiter returned a route for the $100,000 sale this tick, 0 when it returned none (or the asset has no open market at all).",
	}, []string{"asset", "issuer"})

	depthPrice = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_depth_price_usd",
		Help: "Executable USDC price per UI unit of the asset from the $100 sale quote (per raw unit times 10^decimals; a Token-2022 scaled-UI mint is per pre-multiplier unit).",
	}, []string{"asset", "issuer"})

	supplyUnits = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_onchain_supply_units",
		Help: "Token supply of the mint on Solana, in UI units, from getTokenSupply.",
	}, []string{"asset", "issuer"})

	supplyUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_onchain_supply_usd",
		Help: "Token supply on Solana valued at the executable $100 quote price (raw supply times USD per raw unit), or at the fund's fixed NAV for a fund with no market and a designed unit value (BUIDL, $1.00).",
	}, []string{"asset", "issuer"})

	depthHealth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_depth_health",
		Help: "1 when the last tick produced the $100k cost for a routed asset (or confirmed the absence of a route for an unrouted one), 0 otherwise.",
	}, []string{"asset"})

	depthLastSuccess = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_depth_last_success_timestamp_seconds",
		Help: "Unix time of the last tick on which the asset was measured (cost published, or absence of a route confirmed).",
	}, []string{"asset"})

	sourceCall = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "rwa_depth_source_call_total",
		Help: "Fetch outcomes per source (jup_quote, solana_rpc).",
	}, []string{"source", "result"})
)

func init() {
	for _, s := range sizes {
		depthCost[s.Suffix] = promauto.NewGaugeVec(prometheus.GaugeOpts{
			Name: "rwa_depth_cost_" + s.Suffix + "_bps",
			Help: "Cost of selling $" + s.Suffix + " of the asset on Jupiter relative to a $100 sale on the same tick, in basis points (positive = worse price at size).",
		}, []string{"asset", "issuer"})
	}
}

func startMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
