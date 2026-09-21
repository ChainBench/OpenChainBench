package main

import (
	"encoding/json"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Label sets. Kept small and enumerable: every value comes from the persona
// or a fixed adapter table, never from a provider's free text, so
// cardinality is bounded by design (6 providers × 3 assets × 2 methods ×
// 2 notionals × 2 references).
var quoteLabels = []string{"provider", "cohort", "via", "asset", "network", "payment_method", "notional", "fiat", "country", "region", "country_source"}
var premiumLabels = append(append([]string{}, quoteLabels...), "spot_ref")

var (
	allInPremium   *prometheus.GaugeVec
	declaredFee    *prometheus.GaugeVec
	hiddenSpread   *prometheus.GaugeVec
	cryptoOut      *prometheus.GaugeVec
	quoteTTL       *prometheus.GaugeVec
	quoteLatency   *prometheus.HistogramVec
	quoteSuccess   *prometheus.GaugeVec
	quoteErrors    *prometheus.CounterVec
	quoteSamples   *prometheus.CounterVec
	limitsMinFiat  *prometheus.GaugeVec
	limitsMaxFiat  *prometheus.GaugeVec
	spotPrice      *prometheus.GaugeVec
	spotDivergence *prometheus.GaugeVec
	lastCycleTS    prometheus.Gauge
)

func init() {
	allInPremium = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "onramp_quote_all_in_premium_bps",
		Help: "(fiat_in / crypto_out - spot) / spot * 1e4. Effective price paid per unit vs the labelled spot reference, in basis points. Spot is sampled in the same cycle as the quote.",
	}, premiumLabels)
	declaredFee = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "onramp_quote_declared_fee_bps",
		Help: "(fee_provider + fee_partner + fee_network) / fiat_in * 1e4, every fee field the provider returns, in basis points.",
	}, quoteLabels)
	hiddenSpread = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "onramp_quote_hidden_spread_bps",
		Help: "all_in_premium_bps - declared_fee_bps. The markup embedded in the provider's exchange rate that it does not call a fee.",
	}, premiumLabels)
	cryptoOut = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "onramp_quote_crypto_out",
		Help: "Whole units of the asset the provider quotes for the persona's fiat_in.",
	}, quoteLabels)
	quoteTTL = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "onramp_quote_ttl_seconds",
		Help: "Quote validity as returned by the provider. Absent when the provider returns none.",
	}, quoteLabels)
	quoteLatency = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "onramp_quote_latency_ms",
		Help:    "Round-trip time of the quote request, milliseconds.",
		Buckets: []float64{50, 100, 200, 400, 800, 1500, 3000, 6000, 8000},
	}, []string{"provider"})
	quoteSuccess = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "onramp_quote_success",
		Help: "1 when the cycle produced a usable quote (crypto_out > 0, TTL not expired at receipt) inside the 8 s timeout, else 0.",
	}, quoteLabels)
	quoteErrors = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "onramp_quote_errors_total",
		Help: "Failed quote attempts by reason: timeout, http_4xx, http_5xx, parse, no_quote, skipped_no_key.",
	}, []string{"provider", "reason"})
	quoteSamples = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "onramp_quote_samples_total",
		Help: "Usable quotes recorded per cell. A counter, so increase() over the window counts quote events rather than Prometheus scrapes of a gauge.",
	}, quoteLabels)
	limitsMinFiat = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "onramp_limits_min_fiat",
		Help: "Minimum fiat amount the provider accepts for this payment method, EUR. Refreshed hourly.",
	}, []string{"provider", "payment_method", "asset"})
	limitsMaxFiat = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "onramp_limits_max_fiat",
		Help: "Maximum fiat amount the provider accepts for this payment method, EUR. Refreshed hourly.",
	}, []string{"provider", "payment_method", "asset"})
	spotPrice = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "spot_reference_price",
		Help: "Reference mid used for the premium, fiat per whole unit, by source (kraken_eur or pyth). Published for auditability.",
	}, []string{"asset", "fiat", "source"})
	spotDivergence = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "spot_reference_divergence_bps",
		Help: "(kraken_eur - pyth) / pyth * 1e4 per asset. A reference outage or a stale feed shows here before it shows in the premium.",
	}, []string{"asset", "fiat"})
	lastCycleTS = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "onramp_last_cycle_timestamp_seconds",
		Help: "Unix time the last quote cycle finished.",
	})
	for _, c := range []prometheus.Collector{allInPremium, declaredFee, hiddenSpread, cryptoOut, quoteTTL, quoteLatency, quoteSuccess, quoteErrors, quoteSamples, limitsMinFiat, limitsMaxFiat, spotPrice, spotDivergence, lastCycleTS} {
		prometheus.MustRegister(c)
	}
}

func labelsFor(q NormalizedQuote) prometheus.Labels {
	return prometheus.Labels{
		"provider": q.Provider, "cohort": q.Cohort, "via": q.Via,
		"asset": q.Asset, "network": q.Network, "payment_method": q.PaymentMethod,
		"notional": trimFloat(q.Notional), "fiat": PersonaFiat, "country": PersonaCountry,
		"region": PersonaRegion, "country_source": q.CountrySource,
	}
}

func withRef(l prometheus.Labels, ref string) prometheus.Labels {
	out := prometheus.Labels{}
	for k, v := range l {
		out[k] = v
	}
	out["spot_ref"] = ref
	return out
}

// DeleteQuoteSeries clears a provider × dims cell so a provider that stops
// answering does not keep serving its last value to the scraper. Same
// rule as bench 001's gauge purge.
func DeleteQuoteSeries(l prometheus.Labels) {
	declaredFee.Delete(l)
	cryptoOut.Delete(l)
	quoteTTL.Delete(l)
	for _, ref := range []string{"kraken_eur", "pyth"} {
		allInPremium.Delete(withRef(l, ref))
		hiddenSpread.Delete(withRef(l, ref))
	}
}

func StartMetricsServer(addr string, cfg *Config) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cfg.Redacted())
	})
	return http.ListenAndServe(addr, mux)
}
