package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Absolute gap buckets, in basis points. Dense below 20 where the field
// sits, wide above so a broken price (a scam token answering for "BTC",
// a frozen feed during a move) lands in a bucket rather than in +Inf only.
var deviationBuckets = []float64{0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100, 200, 500, 1000}

var (
	deviation = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "price_api_deviation_bps",
		Help:    "Absolute gap between the provider's published USD price and the exchange mid of the same moment, in basis points.",
		Buckets: deviationBuckets,
	}, []string{"provider", "asset"})

	signedDeviation = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "price_api_signed_deviation_bps",
		Help: "Signed gap of the last answer against the exchange mid, in basis points. Positive means the provider prints above the market.",
	}, []string{"provider", "asset"})

	price = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "price_api_price_usd",
		Help: "Last USD price the provider returned.",
	}, []string{"provider", "asset"})

	priceAge = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "price_api_price_age_seconds",
		Help: "Age of the price at the moment it was received, from the provider's own last-updated timestamp. Absent for providers that publish none.",
	}, []string{"provider", "asset"})

	requests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "price_api_requests_total",
		Help: "Provider requests by outcome: ok, rate_limited, http_4xx, http_5xx, timeout, decode, error.",
	}, []string{"provider", "status"})

	assetPolls = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "price_api_asset_polls_total",
		Help: "Per-asset outcome of each poll: ok (scored), missing (no usable price in the answer), failed (request failed), no_reference (exchange mid unavailable, not the provider's fault).",
	}, []string{"provider", "asset", "status"})

	referenceMid = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "price_api_reference_mid_usd",
		Help: "Exchange reference mid: median of the Coinbase, Kraken and Binance mids, in USD.",
	}, []string{"asset"})

	referenceSources = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "price_api_reference_sources",
		Help: "Number of exchanges behind the last reference mid for the asset (2 or 3; under 2 the asset is not scored).",
	}, []string{"asset"})

	usdtUSD = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "price_api_usdt_usd",
		Help: "USDT/USD mid on Kraken, used to convert Binance's USDT books to USD.",
	})

	pollInterval = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "price_api_poll_interval_seconds",
		Help: "How often the provider is polled, set by its quota.",
	}, []string{"provider"})
)
