package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// ─── what this harness publishes, and why in this shape ───────────────
//
// Four questions, four metric families. Every one is derived from a quote
// or a public list; this harness never signs or sends anything, holds no
// key and has no wallet, so nothing it does can spend money.
//
// Costs are histograms rather than gauges because the question a board
// asks is "what does this usually cost over a day", and a gauge holds only
// the last tick. Buckets are chosen around the costs actually measured on
// 2026-10-25: a BTC round trip through Zcash on Maya came back at 325 bps
// with a 0.02 % spread over five samples, so the interesting range is tens
// to low hundreds of bps and the tail needs room for a thin pool. A single
// populated bucket makes a percentile a constant of the bucket layout
// rather than a measurement, which is a defect this repo has shipped
// before, so the grid is fine where the mass is.
var (
	roundTripBps *prometheus.HistogramVec
	roundTripSec *prometheus.HistogramVec
	exitCostBps  *prometheus.HistogramVec

	// Delivery capability is not a cost, it is a yes or no with a reason.
	// 1 means a valid shielded destination was accepted for that rail and
	// source chain; 0 means refused. The refusal REASON is the finding, so
	// it is carried as its own counter: "generated memo too long for source
	// chain" is a mechanism, while a bare 0 is an opinion.
	shieldedAccepted *prometheus.GaugeVec
	shieldedRefusals *prometheus.CounterVec
	transparentOK    *prometheus.GaugeVec

	// The Monero maker book is an over-the-counter order book, not a quote
	// rail, so it gets its own family and must never share a ranking with
	// the three above.
	xmrMakers     prometheus.Gauge
	xmrDispersion prometheus.Gauge
	xmrBestPrice  prometheus.Gauge
	xmrMinSize    prometheus.Gauge
	xmrMaxSize    prometheus.Gauge

	// Health. A board that cannot tell "the rail is slow" from "our prober
	// failed" publishes the prober's health as the provider's, which this
	// repo has also shipped before.
	probeTotal   *prometheus.CounterVec
	lastSuccess  *prometheus.GaugeVec
	poolDepth    *prometheus.GaugeVec
	quoteOut     *prometheus.GaugeVec
	quoteEta     *prometheus.GaugeVec
	registerOnce bool
)

func initMetrics() {
	if registerOnce {
		return
	}
	registerOnce = true

	bpsBuckets := []float64{5, 10, 25, 50, 100, 150, 200, 300, 400, 600, 900, 1500, 3000}
	secBuckets := []float64{30, 60, 120, 300, 600, 900, 1800, 3600, 7200}

	roundTripBps = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "privacy_round_trip_bps",
		Help:    "Basis points lost going from a liquid asset into a privacy asset and back, from two chained quotes.",
		Buckets: bpsBuckets,
	}, []string{"rail", "asset", "bucket", "region"})

	roundTripSec = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "privacy_round_trip_seconds",
		Help:    "Wall-clock seconds the two legs of the round trip are quoted to take, in plus out.",
		Buckets: secBuckets,
	}, []string{"rail", "asset", "bucket", "region"})

	exitCostBps = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "privacy_exit_cost_bps",
		Help:    "Basis points lost selling a fixed notional of a privacy asset back into a liquid one.",
		Buckets: bpsBuckets,
	}, []string{"rail", "asset", "bucket", "region"})

	shieldedAccepted = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_shielded_payout_accepted",
		Help: "1 if the rail accepted a checksum-valid shielded destination for this source chain, 0 if it refused.",
	}, []string{"rail", "source_chain", "asset"})

	transparentOK = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_transparent_payout_accepted",
		Help: "The control. 1 if a checksum-valid transparent destination was accepted. A shielded refusal means nothing while this is 0.",
	}, []string{"rail", "source_chain", "asset"})

	shieldedRefusals = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "privacy_shielded_refusal_total",
		Help: "Refusals of a shielded destination, by the reason the rail gave.",
	}, []string{"rail", "source_chain", "reason"})

	xmrMakers = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "privacy_xmr_maker_count",
		Help: "Makers currently quoting BTC to XMR atomic swaps.",
	})
	xmrDispersion = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "privacy_xmr_price_dispersion_pct",
		Help: "Spread between the best and worst maker quote, as a percent of the median.",
	})
	xmrBestPrice = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "privacy_xmr_best_sat_per_xmr",
		Help: "Best maker price in satoshi per XMR.",
	})
	xmrMinSize = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "privacy_xmr_min_swap_sat",
		Help: "Smallest swap any maker will take, in satoshi.",
	})
	xmrMaxSize = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "privacy_xmr_max_swap_sat",
		Help: "Largest swap any maker will take, in satoshi.",
	})

	probeTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "privacy_probe_total",
		Help: "Probes by rail and outcome, so a prober failure is never published as a rail failure.",
	}, []string{"rail", "probe", "outcome"})

	lastSuccess = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_last_success_timestamp_seconds",
		Help: "Unix time of the last successful probe per rail and probe kind. A board reading a 24h median with a stale stamp here is reading a frozen feed.",
	}, []string{"rail", "probe"})

	quoteOut = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_quote_out_asset",
		Help: "Whole destination-asset units a rail quotes for a fixed input, per destination kind (transparent or shielded).",
	}, []string{"rail", "asset", "destination", "region"})

	quoteEta = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_quote_eta_seconds",
		Help: "Seconds the rail estimates for the swap, per destination kind.",
	}, []string{"rail", "asset", "destination", "region"})

	poolDepth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_pool_depth_asset",
		Help: "Depth of the rail's privacy-asset pool, in whole asset units, so a cost can be read against the liquidity that produced it.",
	}, []string{"rail", "asset"})
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	setupLogsEndpoint(mux)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
