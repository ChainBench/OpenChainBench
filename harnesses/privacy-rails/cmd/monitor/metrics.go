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
// Costs are gauges, not histograms, and the choice is not cosmetic: a
// Histogram exposes _bucket, _sum and _count and never a series under its
// own name, so a quantile_over_time on the metric name matches nothing and
// every row renders empty. That is how the first version of this file would
// have published a board with a title and no numbers.
//
// A gauge sampled each tick and quantiled over 24h is the pattern the
// sibling cost bench already uses (rwa_depth_cost_100k_bps), and it keeps
// the published percentile a property of the samples instead of a property
// of a bucket grid chosen by hand. Each (rail, asset, bucket, region) tuple
// is its own series, so one gauge per tuple loses nothing.
var (
	roundTripBps *prometheus.GaugeVec
	roundTripSec *prometheus.GaugeVec
	exitCostBps  *prometheus.GaugeVec

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
	// One family for every peer-to-peer book, keyed by venue and coin.
	// These were unlabelled singletons, which is exactly why a board could
	// not be built on them: a bench needs rows keyed by a label, and an
	// unlabelled gauge is one row at best.
	bookMakers     *prometheus.GaugeVec
	bookOffers     *prometheus.GaugeVec
	bookPairs      *prometheus.GaugeVec
	bookSize       *prometheus.GaugeVec
	bookDispersion *prometheus.GaugeVec
	bookBestPrice  *prometheus.GaugeVec
	bookMinSize    *prometheus.GaugeVec
	bookMaxSize    *prometheus.GaugeVec

	// Health. A board that cannot tell "the rail is slow" from "our prober
	// failed" publishes the prober's health as the provider's, which this
	// repo has also shipped before.
	probeTotal    *prometheus.CounterVec
	lastSuccess   *prometheus.GaugeVec
	poolDepth     *prometheus.GaugeVec
	quoteOut      *prometheus.GaugeVec
	streamSeconds *prometheus.GaugeVec
	quoteEta      *prometheus.GaugeVec
	registerOnce  bool
)

func initMetrics() {
	if registerOnce {
		return
	}
	registerOnce = true

	roundTripBps = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_round_trip_bps",
		Help: "Basis points lost going from a liquid asset into a privacy asset and back, from two chained quotes.",
	}, []string{"rail", "asset", "bucket", "region"})

	roundTripSec = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_round_trip_seconds",
		Help: "Seconds the two legs of the round trip are quoted to take, in plus out.",
	}, []string{"rail", "asset", "bucket", "region"})

	exitCostBps = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_exit_cost_bps",
		Help: "Basis points lost selling a fixed notional of a privacy asset back into a liquid one.",
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

	lbl := []string{"venue", "coin"}
	bookMakers = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_book_maker_count",
		Help: "Distinct makers with a live offer for this coin. The column that separates a market from one person's standing order.",
	}, lbl)
	bookOffers = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_book_live_offers",
		Help: "Live, unexpired offers touching this coin.",
	}, lbl)
	bookPairs = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_book_pairs",
		Help: "Distinct trading pairs this coin appears in.",
	}, lbl)
	bookSize = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_book_size_offered",
		Help: "Whole coins on offer, summed from the feed's own formatted amounts rather than from raw units, because these coins do not share a decimal count.",
	}, lbl)
	bookDispersion = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_book_price_dispersion_pct",
		Help: "Spread between the best and worst maker price, as a percent of the median. Needs at least two makers.",
	}, lbl)
	bookBestPrice = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_book_best_price",
		Help: "Best maker price, in the venue's own unit.",
	}, lbl)
	bookMinSize = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_book_min_swap",
		Help: "Smallest swap any maker will take, in the venue's own unit.",
	}, lbl)
	bookMaxSize = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_book_max_swap",
		Help: "Largest swap any maker will take, in the venue's own unit.",
	}, lbl)

	probeTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "privacy_probe_total",
		Help: "Probes by rail and outcome, so a prober failure is never published as a rail failure.",
	}, []string{"rail", "probe", "outcome"})

	lastSuccess = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_last_success_timestamp_seconds",
		Help: "Unix time of the last successful probe per rail and probe kind. A board reading a 24h median with a stale stamp here is reading a frozen feed.",
	}, []string{"rail", "probe"})

	// A rail can buy a cheap price with time, and the board must say so or
	// it compares two different trades. THORChain quoted a size worth about
	// a third of its ZEC pool at 61.7 bps round trip, which no AMM does at
	// that fraction: the response carries streaming_swap_blocks 96 and
	// max_streaming_quantity 286, so the swap is split into hundreds of
	// sub-swaps. The slippage is real and it was paid in seconds.
	streamSeconds = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "privacy_streaming_swap_seconds",
		Help: "Seconds the rail will spend streaming the swap in sub-swaps to cut slippage. 0 means the swap is not streamed.",
	}, []string{"rail", "asset", "bucket", "region"})

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
