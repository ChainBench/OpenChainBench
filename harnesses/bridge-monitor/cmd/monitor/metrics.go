package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// Quote latency (time to get quote response)
	bridgeQuoteLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "bridge_quote_latency_ms",
		Help:    "Latency to get bridge quote in milliseconds",
		Buckets: []float64{50, 100, 200, 500, 1000, 2000, 5000, 10000},
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Execution latency (broadcast to funds received)
	bridgeExecutionLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "bridge_execution_latency_ms",
		Help:    "Latency from broadcast to funds received in milliseconds",
		Buckets: []float64{1000, 5000, 10000, 30000, 60000, 120000, 300000, 600000},
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// End-to-end latency (quote to funds received)
	bridgeE2ELatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "bridge_e2e_latency_ms",
		Help:    "End-to-end latency from quote to funds received in milliseconds",
		Buckets: []float64{1000, 5000, 10000, 30000, 60000, 120000, 300000, 600000},
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Fees in USD
	bridgeFeesUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_fees_usd",
		Help: "Bridge fees in USD",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Fees in percentage
	bridgeFeesPercent = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_fees_percent",
		Help: "Bridge fees as percentage of amount",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Success counter
	bridgeSuccess = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "bridge_success_total",
		Help: "Total number of successful bridge transactions",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Revert counter
	bridgeReverts = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "bridge_reverts_total",
		Help: "Total number of reverted/refunded bridge transactions",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Error counter
	bridgeErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "bridge_errors_total",
		Help: "Total number of bridge errors",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain", "error_type"})

	// NOTE: bridge_revert_rate was previously declared as a gauge but never populated.
	// The dashboard and HighBridgeRevertRate alert now compute the rate directly from
	// bridge_reverts_total and bridge_success_total via promql, so the dead gauge was
	// removed. Keep this comment as a reminder if someone wants to re-add a snapshot.

	// Total cost in USD (fees + slippage + gas) - extracted from quote
	bridgeCostUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_cost_usd",
		Help: "Total cost in USD (bridge fees + slippage + gas) extracted from quote",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Total cost as percentage of amount
	bridgeCostPercent = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_cost_percent",
		Help: "Total cost as percentage of amount",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Slippage in USD (output - input)
	bridgeSlippageUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_slippage_usd",
		Help: "Slippage in USD (difference between input and output value)",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Gas fee in USD
	bridgeGasUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_gas_usd",
		Help: "Gas fees in USD",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Fix fee (Debridge-specific, in USD)
	bridgeFixFeeUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_fix_fee_usd",
		Help: "Fixed fee in USD (Debridge native-token fees)",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Estimated execution time (from quote, bridge's promise)
	bridgeEstimatedTimeMs = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_estimated_time_ms",
		Help: "Estimated execution time in ms as promised by the bridge quote",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Quote success (1 = quote returned, 0 = error/unsupported)
	bridgeQuoteSuccess = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_quote_success",
		Help: "1 if the quote returned successfully, 0 if error/unsupported",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Output amount in USD
	bridgeOutputUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_output_usd",
		Help: "Output amount in USD after bridge",
	}, []string{"bridge", "from_chain", "to_chain", "from_token", "to_token", "amount_usd", "region", "chain"})

	// Wallet balance in USD, per chain / token. Drives low-balance alerts.
	walletBalanceUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "wallet_balance_usd",
		Help: "Wallet balance in USD, labelled by chain and token (triangle + gas)",
	}, []string{"chain", "token", "region"})

	// Updated to now() each time the wallet balances are successfully refreshed.
	// Lets us alert if the refresh loop stops.
	walletBalanceLastUpdate = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "wallet_balance_last_update_timestamp_seconds",
		Help: "Unix timestamp of the last successful wallet balance refresh",
	})

	// Consecutive execution failures per bridge. Resets on any success.
	bridgeConsecutiveFailures = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_consecutive_failures",
		Help: "Number of consecutive execution failures for a bridge (resets on success)",
	}, []string{"bridge", "region"})
)
