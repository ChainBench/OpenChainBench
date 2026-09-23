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

	// L2Beat-sourced ────────────────────────────────────────────────
	// Value secured, split by where it came from. `chain_tvl_usd` above
	// counts what DeFi protocols hold on the chain; these count what the
	// chain's bridge secures, which is a different and larger number.
	chainTvsUsd = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "chain_tvs_usd",
			Help: "Total value secured by this rollup in USD, all origins. Source: L2Beat /api/scaling/summary. Updated every 15 min.",
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
		chainTvsUsd, chainValueSecuredUsd, chainBridgedTvlUsd,
		chainTvsChange7dPct, chainTvsChange7dExcessPct,
		chainTvsCohortMedian7dPct, chainTvsCohortSize,
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
