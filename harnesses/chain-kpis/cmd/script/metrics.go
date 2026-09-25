package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// All gauges are keyed by `chain=<OCB slug>`. The site reads them with
// the exact same selector via `fetchChainKpis(slug)`. Naming convention
// is `chain_<metric>_<source>` so a reader can tell at a glance which
// API the value came from.
var (
	// DefiLlama-sourced ─────────────────────────────────────────────
	chainTvlUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_tvl_usd",
			Help: "Total Value Locked in USD across all DeFi protocols on this chain. Source: DefiLlama /v2/historicalChainTvl. Updated every 15 min.",
		},
		[]string{"chain"},
	)
	chainDexVolume24hUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_dex_volume_24h_usd",
			Help: "Aggregate 24h DEX trading volume in USD on this chain across DefiLlama-tracked DEXes. Source: DefiLlama /overview/dexs. Updated every 15 min.",
		},
		[]string{"chain"},
	)
	chainStablesMcapUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_stables_mcap_usd",
			Help: "USD-pegged stablecoin circulating market cap on this chain. Source: DefiLlama /stablecoincharts. Updated every 15 min.",
		},
		[]string{"chain"},
	)

	// Where the money moved, from the same /stablecoincharts history the
	// mcap gauge reads. L2Beat answers this for rollups; stablecoin float
	// answers it for every chain, including the settled L1s L2Beat does
	// not track. It is arguably the better measure: bridged TVL is a stock
	// at rest, while a chain's stablecoin float only grows when someone
	// mints or bridges dollars onto it on purpose.
	chainStablesChange7dPct = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_stables_change_7d_pct",
			Help: "Change in stablecoin float over the trailing 7 days, in percent. Source: DefiLlama /stablecoincharts.",
		},
		[]string{"chain"},
	)
	chainStablesChange30dPct = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_stables_change_30d_pct",
			Help: "Change in stablecoin float over the trailing 30 days, in percent. Source: DefiLlama /stablecoincharts.",
		},
		[]string{"chain"},
	)
	chainStablesNet7dUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_stables_net_7d_usd",
			Help: "Dollar change in stablecoin float over the trailing 7 days. Positive means dollars arrived on this chain.",
		},
		[]string{"chain"},
	)
	chainStablesNet30dUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_stables_net_30d_usd",
			Help: "Dollar change in stablecoin float over the trailing 30 days. Positive means dollars arrived on this chain.",
		},
		[]string{"chain"},
	)

	// L2Beat-sourced ────────────────────────────────────────────────
	// Value secured, split by where it came from. `chain_tvl_usd` above
	// counts what DeFi protocols hold on the chain; these count what the
	// chain's bridge secures, which is a different and larger number.
	chainTvsUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_tvs_usd",
			Help: "Total value secured by this chain in USD, all origins. Source: L2Beat /api/scaling/summary. Updated every 15 min.",
		},
		[]string{"chain"},
	)
	chainValueSecuredUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_value_secured_usd",
			Help: "Value secured in USD by origin: native (minted here), canonical (locked in the chain's own escrow), external (third-party bridge). Source: L2Beat /api/scaling/summary. Updated every 15 min.",
		},
		[]string{"chain", "origin"},
	)
	chainBridgedTvlUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_bridged_tvl_usd",
			Help: "Bridged TVL in USD: canonical + external, the value that arrived from another chain rather than being minted here. Source: L2Beat /api/scaling/summary. Updated every 15 min.",
		},
		[]string{"chain"},
	)
	chainTvsChange7dPct = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_tvs_change_7d_pct",
			Help: "Change in total value secured over the trailing 7 days, in percent. Source: L2Beat /api/scaling/summary.",
		},
		[]string{"chain"},
	)
	chainTvsChange7dExcessPct = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_tvs_change_7d_excess_pct",
			Help: "7-day change in value secured minus the cohort median, in percentage points. Positive means the chain gained ground on its peers; the raw change mostly tracks the market.",
		},
		[]string{"chain"},
	)
	// Cohort scalars: the yardstick the excess is measured against, published
	// so a reader can check the subtraction instead of taking it on trust.
	chainTvsCohortMedian7dPct = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "chain_tvs_cohort_median_7d_pct",
			Help: "Median 7-day change in value secured across every live L2Beat project above the size floor, in percent.",
		},
	)
	chainTvsCohortSize = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "chain_tvs_cohort_size",
			Help: "Number of live L2Beat projects above the size floor that the median is taken over.",
		},
	)
	chainTvsCohortUnderReview = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "chain_tvs_cohort_under_review",
			Help: "How many of the median cohort L2Beat currently marks under review. They are counted, not filtered; this says how much of the yardstick rests on figures being re-verified.",
		},
	)
	chainTvsCohortLayer3 = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "chain_tvs_cohort_layer3",
			Help: "How many of the median cohort are layer 3s settling on another rollup rather than on an L1.",
		},
	)
	// Freshness for the bench. Separate from chain_kpis_last_refresh_timestamp_seconds,
	// which carries a source label: a max() over that stays fresh on the
	// DefiLlama tick while L2Beat is hours stale.
	chainKpisL2BeatLastSuccessUnix = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "chain_kpis_l2beat_last_success_unix",
			Help: "Unix timestamp of the last L2Beat fetch that published at least one chain. Says our call worked, not that upstream is current.",
		},
	)
	chainKpisL2BeatSyncedUntilUnix = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "chain_kpis_l2beat_synced_until_unix",
			Help: "Unix timestamp of the last point L2Beat has computed (chart.syncedUntil). The series is hourly and normally runs 1-2h behind, so this is the only clock that stops when upstream stalls while still answering 200.",
		},
	)

	// DefiLlama fees overview ───────────────────────────────────────
	// What users paid on the chain and what the chain (or its protocols)
	// kept, per DefiLlama's per-chain fees adapters, over windows ending
	// on DefiLlama's last complete UTC day. Hourly.
	chainFees24hUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_fees_24h_usd",
			Help: "Fees paid on this chain over DefiLlama's last complete UTC day, in USD: gas plus the fees of every DefiLlama-tracked protocol on the chain. Source: DefiLlama /overview/fees/<chain> dailyFees.",
		},
		[]string{"chain"},
	)
	chainFees7dUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_fees_7d_usd",
			Help: "Fees paid on this chain over the trailing 7 complete UTC days, in USD. Source: DefiLlama /overview/fees/<chain> dailyFees.",
		},
		[]string{"chain"},
	)
	chainFees30dUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_fees_30d_usd",
			Help: "Fees paid on this chain over the trailing 30 complete UTC days, in USD. Source: DefiLlama /overview/fees/<chain> dailyFees.",
		},
		[]string{"chain"},
	)
	chainRevenue24hUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_revenue_24h_usd",
			Help: "Revenue kept by the chain and its protocols over DefiLlama's last complete UTC day, in USD (fees minus what is passed to LPs, stakers and users). Source: DefiLlama /overview/fees/<chain> dailyRevenue.",
		},
		[]string{"chain"},
	)
	chainRevenue7dUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_revenue_7d_usd",
			Help: "Revenue kept on this chain over the trailing 7 complete UTC days, in USD. Source: DefiLlama /overview/fees/<chain> dailyRevenue.",
		},
		[]string{"chain"},
	)
	chainRevenue30dUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_revenue_30d_usd",
			Help: "Revenue kept on this chain over the trailing 30 complete UTC days, in USD. Source: DefiLlama /overview/fees/<chain> dailyRevenue.",
		},
		[]string{"chain"},
	)
	chainRevenueSharePct = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_revenue_share_pct",
			Help: "30-day revenue over 30-day fees, in percent: how much of what users paid the chain and its protocols kept.",
		},
		[]string{"chain"},
	)
	chainTokenMcapUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_token_mcap_usd",
			Help: "Circulating market cap in USD of the chain's own token per DefiLlama's chain to gecko_id mapping (Ethereum ETH, Arbitrum ARB, Hyperliquid HYPE), from CoinGecko. Absent for chains with no token of their own (Base, Robinhood Chain, Unichain).",
		},
		[]string{"chain"},
	)
	chainFeesIncomplete = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_fees_incomplete",
			Help: "1 when DefiLlama's chain fee total is short of the adapters it attributes to that chain by more than half. The fee figure is still published; the price to fees and price to sales ratios are not, because the denominator is one the source itself contradicts. chain_fees_adapter_coverage carries the size of the gap.",
		},
		[]string{"chain"},
	)
	chainFeesAdapterCoverage = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_fees_adapter_coverage",
			Help: "Sum of the 30-day fees of a chain's DefiLlama adapters divided by the chain total DefiLlama reports. Around 1.0 when the aggregate holds; well above 1.0 when the chain aggregate leaves adapters out.",
		},
		[]string{"chain"},
	)
	chainTokenPfRatio = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_token_pf_ratio",
			Help: "chain_token_mcap_usd over annualized chain fees (30-day fees x 365/30). Published only when both exist and the fee total is not flagged incomplete; lower means the market pays less per dollar of fees.",
		},
		[]string{"chain"},
	)
	chainTokenPsRatio = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_token_ps_ratio",
			Help: "chain_token_mcap_usd over annualized chain revenue (30-day revenue x 365/30). Published only when both exist and revenue is positive.",
		},
		[]string{"chain"},
	)
	chainFeesLastSuccessUnix = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "chain_fees_last_success_unix",
			Help: "Unix timestamp of the last fees poll that published at least one chain. The figures themselves move once a day, on DefiLlama's day close.",
		},
	)

	// Mobula-sourced ────────────────────────────────────────────────
	chainNativePriceUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_native_price_usd",
			Help: "Current USD price of the chain's native token. Source: Mobula /market/data. Updated every 5 min.",
		},
		[]string{"chain", "symbol"},
	)
	chainNativeMcapUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_native_mcap_usd",
			Help: "Circulating market cap (USD) of the chain's native token. Source: Mobula /market/data. Updated every 5 min.",
		},
		[]string{"chain", "symbol"},
	)
	chainMobulaTokensIndexed = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_mobula_tokens_indexed",
			Help: "Number of tokens Mobula's indexer tracks on this chain. Source: Mobula /market/blockchain/stats. Updated every 5 min.",
		},
		[]string{"chain"},
	)

	// Observability ──────────────────────────────────────────────────
	// 1 when the last fetch for this chain and source returned usable
	// data, 0 when it did not. Benches read the 24h average of this as
	// their success rate, the same shape as perp_venue_health and
	// tx_fee_health. It is deliberately per source: DefiLlama can be
	// healthy while L2Beat is down, and a chain page renders the half
	// that works.
	chainKpisHealth = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_kpis_health",
			Help: "1 if the last fetch for this chain and source returned data, 0 otherwise.",
		},
		[]string{"chain", "source"},
	)
	chainKpisLastRefresh = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_kpis_last_refresh_timestamp_seconds",
			Help: "Unix timestamp of the last successful refresh per chain per source.",
		},
		[]string{"chain", "source"},
	)
	chainKpisFetchLatencyMs = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_kpis_fetch_latency_milliseconds",
			Help: "Wall-clock fetch latency per chain per source.",
		},
		[]string{"chain", "source"},
	)
	chainKpisFetchErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "chain_kpis_fetch_errors_total",
			Help: "Total number of fetch failures per chain per source, by error type.",
		},
		[]string{"chain", "source", "error_type"},
	)
	chainKpisLastTickUnix = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "chain_kpis_last_tick_unix",
			Help: "Unix timestamp of the last harness tick (any source). Liveness probe for the cron alerter.",
		},
	)
)

func init() {
	prometheus.MustRegister(
		chainTvlUsd, chainDexVolume24hUsd, chainStablesMcapUsd,
		chainStablesChange7dPct, chainStablesChange30dPct,
		chainStablesNet7dUsd, chainStablesNet30dUsd,
		chainTvsUsd, chainValueSecuredUsd, chainBridgedTvlUsd,
		chainTvsChange7dPct, chainTvsChange7dExcessPct,
		chainTvsCohortMedian7dPct, chainTvsCohortSize,
		chainTvsCohortUnderReview, chainTvsCohortLayer3,
		chainKpisL2BeatLastSuccessUnix, chainKpisL2BeatSyncedUntilUnix,
		chainFees24hUsd, chainFees7dUsd, chainFees30dUsd,
		chainRevenue24hUsd, chainRevenue7dUsd, chainRevenue30dUsd,
		chainRevenueSharePct, chainTokenMcapUsd, chainTokenPfRatio, chainTokenPsRatio,
		chainFeesIncomplete, chainFeesAdapterCoverage,
		chainFeesLastSuccessUnix,
		chainNativePriceUsd, chainNativeMcapUsd, chainMobulaTokensIndexed,
		chainKpisHealth, chainKpisLastRefresh, chainKpisFetchLatencyMs, chainKpisFetchErrors,
		chainKpisLastTickUnix,
	)
}

// classifyError buckets a fetch error string into a small finite enum so
// chain_kpis_fetch_errors_total stays bounded in cardinality. Same shape
// as network-coverage's classifier (timeout, auth, rate_limit, server,
// other) so the OCB dashboards can reuse one template across harnesses.
func classifyError(msg string) string {
	switch {
	case contains(msg, "timeout"), contains(msg, "deadline"):
		return "timeout"
	case contains(msg, "401"), contains(msg, "403"), contains(msg, "unauthorized"):
		return "auth"
	case contains(msg, "429"):
		return "rate_limit"
	case contains(msg, "500"), contains(msg, "502"), contains(msg, "503"), contains(msg, "504"):
		return "server_error"
	case contains(msg, "404"):
		return "not_found"
	case contains(msg, "not_tracked"), contains(msg, "empty_series"):
		// Expected: the upstream confirmed the chain is supported but has
		// no data for this KPI yet (e.g. Stellar/Blast for stables today).
		// Keep it out of "other" so dashboards don't false-positive.
		return "not_tracked"
	default:
		return "other"
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("OK")) })
	return http.ListenAndServe(addr, mux)
}
