package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the OCB stablecoin peg deviation bench. All
// deviation values are in **basis points** (1 bp = 0.0001 = 0.01%)
// because that's how the industry talks about peg-deviation.
//
// Naming: `peg_<measurement>_<unit>` matches the rest of the OCB
// suite. The spec YAML uses these directly via PromQL.
var (
	// Per-venue raw mid-price gauge (USD or USDT as quoted).
	// Useful for the live chart + debugging; not the primary
	// ranking input.
	pegRawPrice = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_raw_price",
			Help: "Latest mid-price observed for a (stable, venue) pair, in the venue's native quote currency. USD-quoted for primary-eligible venues, USDT-quoted for Binance/secondary venues.",
		},
		[]string{"stable", "venue", "quote"},
	)

	// Per-minute aggregated price after liquidity-weighted median
	// across all USD-quoted venues for the stable.
	pegAggregatedPrice = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_aggregated_price_usd",
			Help: "Per-minute liquidity-weighted median price across USD-quoted venues. The percentile metrics are computed from this series.",
		},
		[]string{"stable"},
	)

	// Instantaneous deviation in bps from $1.00 (after
	// aggregation). Drives `quantile_over_time` for the primary
	// metric.
	pegDeviationBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_deviation_bps",
			Help: "Per-minute median absolute deviation from $1.00 in basis points (legacy headline, retained for backward compatibility). The new primary leaderboard ranks on peg_deviation_worst_bps which captures the per-minute MAX, not the median.",
		},
		[]string{"stable"},
	)

	// THE new primary headline. Per-minute MAX deviation across
	// every venue's samples within the bucket — surfaces the worst
	// case the bench observed during the minute. A 5-second depeg
	// to $0.92 is invisible in the median (which averages it with
	// 11 healthy samples in the same minute) but pops out in this
	// gauge. Matches what TradFi reference rates publish as the
	// "high" of an OHLC bar. Methodology recommendation from
	// Coinpaprika data team.
	pegDeviationWorstBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_deviation_worst_bps",
			Help: "Per-minute MAX |price - $1.00| across every venue sample within the bucket, in basis points. Captures sub-minute depeg wicks that the median smooths away. Primary leaderboard metric.",
		},
		[]string{"stable"},
	)

	// Companion OHLC gauges for the same per-minute bucket. open
	// and close are deviation in bps of the first / last sample;
	// max and min are the bucket's extremes. Together they expose
	// the bar shape that a single median value collapses.
	pegMinuteMaxBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_minute_max_bps",
			Help: "MAX |price - $1.00| in bps observed within the most-recently-closed 60s bucket across all venues. Identical to peg_deviation_worst_bps; exposed under both names for legibility.",
		},
		[]string{"stable"},
	)
	pegMinuteMinBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_minute_min_bps",
			Help: "MIN |price - $1.00| in bps observed within the most-recently-closed 60s bucket across all venues. Floor of the bar.",
		},
		[]string{"stable"},
	)
	pegMinuteOpenBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_minute_open_bps",
			Help: "|first_sample_price - $1.00| in bps for the most-recently-closed 60s bucket. Open of the bar.",
		},
		[]string{"stable"},
	)
	pegMinuteCloseBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_minute_close_bps",
			Help: "|last_sample_price - $1.00| in bps for the most-recently-closed 60s bucket. Close of the bar.",
		},
		[]string{"stable"},
	)

	// Same metric but as a histogram so we can also do
	// histogram_quantile if percentile_over_time becomes too
	// expensive at large windows.
	pegDeviationHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "peg_deviation_bps_histogram",
			Help:    "Histogram of |price - $1| in bps per stable. Buckets cover normal noise (1-20 bps) through depeg territory (1000+ bps).",
			Buckets: []float64{1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000},
		},
		[]string{"stable"},
	)

	// THE OCB differentiator: cross-venue gap. max(price across
	// USD-quoted venues) - min(price). Only exists for stables
	// with ≥2 venues in the same minute.
	pegCrossVenueGapBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_cross_venue_gap_bps",
			Help: "Cross-venue price spread (max - min) for a stable in basis points, computed per minute across USD-quoted venues. The headline number nobody else publishes.",
		},
		[]string{"stable"},
	)

	pegCrossVenueGapHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "peg_cross_venue_gap_bps_histogram",
			Help:    "Histogram of cross-venue gap in bps per stable, drives p50/p90/p99 leaderboards.",
			Buckets: []float64{1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000},
		},
		[]string{"stable"},
	)

	// USDT-anchored secondary metric. Same shape, separate from
	// primary so USDT's own peg can't contaminate the headline.
	pegDeviationUsdtAnchoredBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_deviation_usdt_anchored_bps",
			Help: "Deviation of USDT-quoted samples from 1.0, e.g. Binance USDC/USDT. Secondary metric — surfaces 'how X trades vs USDT' without polluting the USD-anchored primary.",
		},
		[]string{"stable", "venue"},
	)

	// Time spent outside the [0.995, 1.005] band over the
	// rolling window. Catches the "always slightly off" failure
	// mode that p99 can hide.
	pegTimeOutsideBandSec = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_time_outside_band_24h_seconds",
			Help: "Seconds in the trailing 24h during which the per-minute aggregated price fell outside [0.995, 1.005] (±50 bps band).",
		},
		[]string{"stable"},
	)

	// Direction split — Circle redeems above-peg only, so USDC
	// time-below-peg is structurally rarer than time-above-peg.
	pegTimeBelowPegSec = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_time_below_peg_24h_seconds",
			Help: "Seconds in the trailing 24h during which the per-minute aggregated price was below 0.995.",
		},
		[]string{"stable"},
	)

	pegTimeAbovePegSec = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_time_above_peg_24h_seconds",
			Help: "Seconds in the trailing 24h during which the per-minute aggregated price was above 1.005.",
		},
		[]string{"stable"},
	)

	// Binary depeg event flag. Set when price has been outside
	// [0.97, 1.03] for ≥5 consecutive minutes; cleared after 30
	// minutes back inside. Conservative so it doesn't flap on
	// normal stress.
	pegDepegEventFlag = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_depeg_event_flag",
			Help: "1 when the stable has been outside [0.97, 1.03] for ≥5 consecutive minutes (active depeg event), 0 otherwise.",
		},
		[]string{"stable"},
	)

	// Source-level health and outlier accounting.
	pegSourceCallTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "peg_source_call_total",
			Help: "Number of source polls broken down by result: ok, http_err, parse_err, stale, dropped (sample dropped by outlier rule).",
		},
		[]string{"stable", "venue", "result"},
	)

	pegSourceHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_source_health",
			Help: "1 when the most recent poll succeeded with a non-stale price, 0 otherwise.",
		},
		[]string{"stable", "venue"},
	)

	// Sample count per minute per source — surfaces thinness.
	pegMinuteSampleCount = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "peg_minute_sample_count",
			Help: "Number of samples received in the most recently closed minute per (stable, venue). Low values for a venue flag thin/intermittent feed.",
		},
		[]string{"stable", "venue"},
	)
)

// StartMetricsServer binds /metrics + /health on addr. Blocking call —
// run in its own goroutine.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("stablecoin-peg harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
