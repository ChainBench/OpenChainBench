package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// Corridor matrix out of each scanned source chain, by CCTP destination.
	usdcOut = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_usdc_out_usd",
		Help: "USDC burned on the source chain for the destination chain over Circle CCTP (v1 and v2 DepositForBurn), trailing window (24h, 7d), in USD at par.",
	}, []string{"source", "destination", "window"})
	usdcOutTotal = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_usdc_out_total_usd",
		Help: "USDC that left the chain over CCTP to every destination, trailing window.",
	}, []string{"chain", "window"})
	usdcIn = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_usdc_in_usd",
		Help: "USDC sent to the chain over CCTP from the scanned source chains, trailing window. Sources not scanned (Solana, Sui, Aptos and others) are not counted.",
	}, []string{"chain", "window"})
	usdcNet = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_usdc_net_usd",
		Help: "bridge_usdc_in_usd minus bridge_usdc_out_total_usd for a scanned chain: net USDC that entered over CCTP from the scanned cohort, trailing window.",
	}, []string{"chain", "window"})
	usdcBurns = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_usdc_burns",
		Help: "Number of CCTP USDC burns on the source chain, trailing window.",
	}, []string{"source", "window"})
	sourceCovered = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_flows_source_health",
		Help: "1 when the chain's last scan reached the head without error, 0 when the scan is behind or failing (its windows then keep their previous values).",
	}, []string{"chain"})
	sourceLag = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_flows_source_lag_blocks",
		Help: "Blocks between the chain head and the last scanned block after the tick.",
	}, []string{"chain"})
	burnsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "bridge_flows_burns_folded_total",
		Help: "USDC burns decoded and folded into buckets since process start, by CCTP version.",
	}, []string{"source", "version"})
	rpcCalls = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "bridge_flows_rpc_calls_total",
		Help: "JSON-RPC calls by chain, endpoint host and outcome.",
	}, []string{"chain", "host", "result"})
	sourceFetches = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "bridge_flows_fetch_total",
		Help: "Fetch outcomes for the non-RPC sources (wormhole, l2beat).",
	}, []string{"source", "result"})

	wormholeVolume = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_wormhole_volume_usd",
		Help: "Volume that left the chain over Wormhole, USD, from Wormholescan per UTC day: window 24h = the last complete UTC day, 7d = the last 7 complete days.",
	}, []string{"chain", "window"})
	wormholeDays = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "bridge_wormhole_days_sampled",
		Help: "Complete UTC days behind the Wormhole 7d sums (7 when complete).",
	})
	wormholeLastTick = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "bridge_wormhole_last_tick_unix",
		Help: "Unix time of the last successful Wormholescan poll.",
	})

	l2TvsChange = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_l2_tvs_change_usd",
		Help: "Change of the L2's bridged value (L2Beat TVS canonical plus external, native excluded) over the window, USD at each point's prices.",
	}, []string{"chain", "window"})
	l2Bridged = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_l2_bridged_value_usd",
		Help: "L2Beat TVS canonical plus external for the L2 at the newest chart point.",
	}, []string{"chain"})
	l2AsOf = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_l2_tvs_as_of_unix",
		Help: "Timestamp of the newest L2Beat chart point used for the chain.",
	}, []string{"chain"})
	l2beatLastTick = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "bridge_l2beat_last_tick_unix",
		Help: "Unix time of the last L2Beat poll.",
	})

	lastTick = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "bridge_flows_last_tick_unix",
		Help: "Unix time of the last CCTP tick that scanned every source chain (with or without per-chain errors) and republished the windows.",
	})
	netUpdated = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "bridge_flows_net_updated_unix",
		Help: "Unix time of the last tick on which every source chain scanned to the head and bridge_usdc_in_usd / bridge_usdc_net_usd were rebuilt. The bench's freshness clock.",
	})
)

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
