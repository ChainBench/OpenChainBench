package main

import (
	"math"
	"math/big"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Mirrors the solana-quote-latency metric family but with a `chain` label
// baked in from day 1 since this harness runs across multiple EVM chains.
// Metric prefix is `evm_swap_quote_*` so the families never collide with
// `solana_quote_*` and the bench page can query each independently.
var (
	quoteLatencyMs  *prometheus.HistogramVec
	quoteSuccess    *prometheus.GaugeVec
	quoteThrottled  *prometheus.CounterVec
	quoteAuthError  *prometheus.CounterVec
	quoteNoRoute    *prometheus.CounterVec
	quoteOtherError *prometheus.CounterVec
)

func init() {
	quoteLatencyMs = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "evm_swap_quote_latency_ms",
			Help:    "EVM swap quote API latency in milliseconds (successful quotes only)",
			Buckets: []float64{10, 25, 50, 100, 200, 500, 1000, 2000, 5000},
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteLatencyMs)

	quoteSuccess = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "evm_swap_quote_success",
			Help: "Last probe outcome per provider (1 = success, 0 = failure)",
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteSuccess)

	quoteThrottled = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "evm_swap_quote_throttled_total",
			Help: "Total HTTP 429 responses per provider",
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteThrottled)

	quoteAuthError = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "evm_swap_quote_auth_error_total",
			Help: "Total HTTP 401/403 responses per provider",
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteAuthError)

	quoteNoRoute = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "evm_swap_quote_no_route_total",
			Help: "Total times a provider returned no route for the requested pair",
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteNoRoute)

	quoteOtherError = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "evm_swap_quote_other_error_total",
			Help: "Total non-auth, non-throttle, non-no-route errors per provider (network, timeout, parse, non-2xx)",
		},
		[]string{"provider", "chain", "region", "error_type"},
	)
	prometheus.MustRegister(quoteOtherError)

	initQuoteOutput()
	initShortfall()
}

func RecordLatency(provider, chain, region string, latencyMs int64) {
	quoteLatencyMs.WithLabelValues(provider, chain, region).Observe(float64(latencyMs))
	quoteSuccess.WithLabelValues(provider, chain, region).Set(1)
}
func RecordThrottled(provider, chain, region string) {
	quoteThrottled.WithLabelValues(provider, chain, region).Inc()
	quoteSuccess.WithLabelValues(provider, chain, region).Set(0)
}
func RecordAuthError(provider, chain, region string) {
	quoteAuthError.WithLabelValues(provider, chain, region).Inc()
	quoteSuccess.WithLabelValues(provider, chain, region).Set(0)
}
func RecordNoRoute(provider, chain, region string) {
	quoteNoRoute.WithLabelValues(provider, chain, region).Inc()
	quoteSuccess.WithLabelValues(provider, chain, region).Set(0)
}
func RecordOtherError(provider, chain, region, errorType string) {
	quoteOtherError.WithLabelValues(provider, chain, region, errorType).Inc()
	quoteSuccess.WithLabelValues(provider, chain, region).Set(0)
}

// StartMetricsServer exposes /metrics, /logs, /healthz on the OCB convention :2112.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	setupLogsEndpoint(mux)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}

// ─── quote output ────────────────────────────────────────────────────
//
// What an aggregator returns, not how fast it returns it.
//
// Published as a gauge of the output in whole destination-token units,
// alongside the provider's own declared fee. No ranking is computed here
// and none should be computed from a single sample: measured on
// 2026-10-19, the market drifted 30 to 37 bps across five probes a minute
// apart while the providers sat within 25 bps of each other, so three
// different names "won" in five runs. The comparison that survives is the
// gap to the best quote of the SAME tick, which is why the tick's
// timestamp is carried as a label-free gauge the query layer can align on.
var (
	quoteOutAmount *prometheus.GaugeVec
	quoteFeeBps    *prometheus.GaugeVec
	quoteBlock     *prometheus.GaugeVec
	quoteTickUnix  *prometheus.GaugeVec
)

func initQuoteOutput() {
	quoteOutAmount = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "evm_swap_quote_out_amount",
			Help: "Quoted output in whole destination-token units for the latest probe of this (provider, chain, pair). Not comparable across ticks: the market moves between them. Compare within one tick.",
		},
		[]string{"provider", "chain", "region", "pair"},
	)
	prometheus.MustRegister(quoteOutAmount)

	quoteFeeBps = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "evm_swap_quote_fee_bps",
			Help: "Fee the provider itself declares on the quote, in basis points. Absent when the provider declares nothing, which is not the same as charging nothing.",
		},
		[]string{"provider", "chain", "region", "pair"},
	)
	prometheus.MustRegister(quoteFeeBps)

	quoteBlock = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "evm_swap_quote_block",
			Help: "Block the provider says it quoted against. Absent when it does not say; only then can two quotes be proven to have seen the same market.",
		},
		[]string{"provider", "chain", "region", "pair"},
	)
	prometheus.MustRegister(quoteBlock)

	quoteTickUnix = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "evm_swap_quote_tick_unix",
			Help: "Unix seconds of the scheduler tick this quote belongs to. Quotes sharing a tick saw the same market and are the only ones worth comparing.",
		},
		[]string{"provider", "chain", "region", "pair"},
	)
	prometheus.MustRegister(quoteTickUnix)
}

// RecordQuote publishes what the provider returned.
//
// The amount is converted to whole units using the pair's declared output
// decimals rather than published raw: a gauge holding 2.4e9 for USDT and
// 1e18 for an 18-decimal token cannot be read on one axis, and Prometheus
// float64 loses precision above 2^53 anyway.
func RecordQuote(provider string, pair TestPair, region string, q Quote) {
	pairLabel := pair.TokenInSym + "/" + pair.TokenOutSym
	if q.OutAmount != "" {
		if v, ok := new(big.Float).SetString(q.OutAmount); ok {
			if !q.OutAlreadyScaled {
				scale := new(big.Float).SetFloat64(math.Pow10(pair.TokenOutDec))
				v = new(big.Float).Quo(v, scale)
			}
			whole, _ := v.Float64()
			quoteOutAmount.WithLabelValues(provider, pair.Chain, region, pairLabel).Set(whole)
		}
	}
	if q.FeeBps >= 0 {
		quoteFeeBps.WithLabelValues(provider, pair.Chain, region, pairLabel).Set(q.FeeBps)
	} else {
		quoteFeeBps.DeleteLabelValues(provider, pair.Chain, region, pairLabel)
	}
	if q.Block > 0 {
		quoteBlock.WithLabelValues(provider, pair.Chain, region, pairLabel).Set(float64(q.Block))
	} else {
		quoteBlock.DeleteLabelValues(provider, pair.Chain, region, pairLabel)
	}
	quoteTickUnix.WithLabelValues(provider, pair.Chain, region, pairLabel).
		Set(float64(time.Now().Unix()))
}

// ─── shortfall against the best quote of the same tick ───────────────
//
// The headline the quote-output board needs, and the only form that
// survives contact with a moving market.
//
// Measured 2026-10-19 on 1 ETH to USDT, five providers, five probes a
// minute apart: the market drifted 30 to 37 bps across the runs while the
// providers sat within 25 bps of each other, and three different names
// "won". Absolute output is therefore not comparable between ticks. The
// gap to the best quote of the SAME tick is, because every provider in
// that tick saw the same market.
//
// Published as a histogram, not a gauge: the question is the median gap
// over a day, which a gauge holding the last tick cannot answer.
//
// Zero means "was the best quote this tick". A positive value is how many
// basis points of output the provider gave up against whoever won it. For
// two of the providers that number is their own declared fee rather than
// routing quality, which is why evm_swap_quote_fee_bps sits beside it:
// LI.FI declares 0.0025 included and measured 25.0, 0x declares a
// zeroExFee worth 15.0 bps and measured 16.3.
var (
	quoteShortfallBps *prometheus.HistogramVec
	quoteTickField    *prometheus.GaugeVec
)

func initShortfall() {
	quoteShortfallBps = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "evm_swap_quote_shortfall_bps",
			Help: "Basis points of output given up against the best quote of the same tick. 0 means it was the best. Only ticks with at least two successful quotes are recorded, since a field of one has no best to miss.",
			// Fine near zero because that is where the field sits: the top
			// three were within 3.4 bps of each other, while a built-in fee
			// shows at 15 to 25.
			Buckets: []float64{0.5, 1, 2, 5, 10, 15, 25, 50, 100, 250, 1000},
		},
		[]string{"provider", "chain", "pair"},
	)
	prometheus.MustRegister(quoteShortfallBps)

	quoteTickField = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "evm_swap_quote_tick_field",
			Help: "How many providers answered the latest tick of this pair. A shortfall measured against a field of two says much less than one measured against seven, so the board must be able to show it.",
		},
		[]string{"chain", "pair"},
	)
	prometheus.MustRegister(quoteTickField)
}

// wholeUnits converts a quote's output to whole destination tokens, which
// is the only form in which two providers' amounts can be compared: most
// return the token's smallest unit, Mobula returns whole tokens already.
func wholeUnits(q Quote, pair TestPair) (float64, bool) {
	v, ok := new(big.Float).SetString(q.OutAmount)
	if !ok {
		return 0, false
	}
	if !q.OutAlreadyScaled {
		v = new(big.Float).Quo(v, new(big.Float).SetFloat64(math.Pow10(pair.TokenOutDec)))
	}
	f, _ := v.Float64()
	if !(f > 0) {
		return 0, false
	}
	return f, true
}

// RecordShortfall measures each provider against the best quote of the
// tick it was fired in.
func RecordShortfall(pair TestPair, region string, quotes map[string]Quote) {
	pairLabel := pair.TokenInSym + "/" + pair.TokenOutSym

	outs := make(map[string]float64, len(quotes))
	best := 0.0
	for slug, q := range quotes {
		v, ok := wholeUnits(q, pair)
		if !ok {
			continue
		}
		outs[slug] = v
		if v > best {
			best = v
		}
	}
	quoteTickField.WithLabelValues(pair.Chain, pairLabel).Set(float64(len(outs)))

	// A field of one has no best to miss. Recording 0 for it would hand a
	// provider a perfect score for being the only one that answered.
	if len(outs) < 2 || best <= 0 {
		return
	}
	for slug, v := range outs {
		bps := 10000 * (best - v) / best
		if bps < 0 {
			bps = 0
		}
		quoteShortfallBps.WithLabelValues(slug, pair.Chain, pairLabel).Observe(bps)
	}
}
