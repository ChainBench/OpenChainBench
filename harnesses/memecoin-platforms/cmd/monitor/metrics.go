package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	platformFeePct = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "memecoin_platform_fee_pct",
		Help: "Explicit on-chain fee as % of trade value (gas + platform referral/bot fees, excludes AMM LP fee)",
	}, []string{"platform", "token", "token_address"})

	platformTotalFeeUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "memecoin_platform_total_fee_usd",
		Help: "Average explicit on-chain fee in USD per trade",
	}, []string{"platform", "token", "token_address"})

	platformTradeCount = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "memecoin_platform_trade_count",
		Help: "Number of trades sampled (amountUSD >= 5) for this platform and token",
	}, []string{"platform", "token", "token_address"})

	pollErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "memecoin_poll_errors_total",
		Help: "Total fetch errors by source",
	}, []string{"source"})

	lastPollTime = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "memecoin_last_poll_timestamp_seconds",
		Help: "Unix timestamp of last successful poll",
	})
)
