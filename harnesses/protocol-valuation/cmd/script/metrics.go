package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Every per-protocol gauge is keyed by `protocol=<OCB slug>`; the category
// rides along on the rows that carry a peer group so a dashboard can group
// without a second lookup.
var (
	pvFees30d = gaugeVec("protocol_fees_30d_usd",
		"Trailing 30d fees in USD, summed across every fee adapter that accrues to this token. Source: DeFiLlama /overview/fees.",
		"protocol", "category")
	pvFeesPrev30d = gaugeVec("protocol_fees_prev_30d_usd",
		"Fees in USD for days 31-60 back, the denominator of the month-over-month trend.", "protocol")
	pvAnnualFees = gaugeVec("protocol_annual_fees_usd",
		"Annualized fees in USD (trailing 30d x 365/30).", "protocol")
	pvFeeGrowth = gaugeVec("protocol_fee_growth_30d_pct",
		"Change in 30d fees against the prior 30 days, in percent.", "protocol")

	pvMcap = gaugeVec("protocol_mcap_usd",
		"Circulating market cap in USD (CoinGecko).", "protocol")
	pvFDV = gaugeVec("protocol_fdv_usd",
		"Fully diluted valuation in USD (CoinGecko).", "protocol")
	pvFloat = gaugeVec("protocol_float_pct",
		"Circulating supply as a percent of total supply (CoinGecko).", "protocol")
	pvPriceChg = gaugeVec("protocol_price_change_30d_pct",
		"Token price change over the trailing 30 days, in percent (CoinGecko).", "protocol")

	pvPF = gaugeVec("protocol_pf_ratio",
		"Price to fees: circulating market cap / annualized fees.", "protocol")
	pvPFfdv = gaugeVec("protocol_pf_fdv_ratio",
		"FDV to fees: fully diluted valuation / annualized fees. The conservative multiple.", "protocol")

	// What the protocol keeps, what it holds, and how much its float grew.
	// Asked for by retail readers who know P/S, TVL and dilution from
	// other screens; each is absent, never zero, when the source has no
	// figure for the token.
	pvRev30d = gaugeVec("protocol_revenue_30d_usd",
		"Trailing 30d revenue in USD, the share of fees the protocol keeps per each adapter's DeFiLlama definition, summed over the same adapters as protocol_fees_30d_usd. Absent when none of them publishes a revenue series.",
		"protocol", "category")
	pvAnnualRev = gaugeVec("protocol_annual_revenue_usd",
		"Annualized revenue in USD (trailing 30d x 365/30).", "protocol")
	pvPS = gaugeVec("protocol_ps_ratio",
		"Price to sales: circulating market cap / annualized revenue. Absent when revenue is missing or zero, and when the revenue total is knowably short (protocol_revenue_incomplete = 1).",
		"protocol", "category")
	pvRevIncomplete = gaugeVec("protocol_revenue_incomplete",
		"1 when the revenue total is knowably short: the token's fee total is (protocol_fees_incomplete), a revenue adapter reports nothing over 30 days after real revenue over the year, or a product earning fees this month has no revenue series while its siblings do. Revenue is published with the flag; P/S is not.",
		"protocol")
	pvRevMissingAdapters = gaugeVec("protocol_revenue_missing_adapters",
		"Fee adapters of this token earning fees this month with no revenue series on DeFiLlama, the size of the coverage gap behind protocol_revenue_incomplete.",
		"protocol")
	pvTVL = gaugeVec("protocol_tvl_usd",
		"Total value locked in USD, summed over every DeFiLlama /protocols row that resolves to this token, own row or parent. Absent when no row carries a TVL.",
		"protocol", "category")
	pvSupplyChg30d = gaugeVec("protocol_supply_change_30d_pct",
		"Realized dilution: circulating supply now against 30 days ago, in percent, from CoinGecko daily market cap / price. Not an unlock schedule. Absent when the series is shorter than 30 days.",
		"protocol", "category")
	pvSupplyChg90d = gaugeVec("protocol_supply_change_90d_pct",
		"Realized dilution: circulating supply now against 90 days ago, in percent, from CoinGecko daily market cap / price. Not an unlock schedule. Absent when the series is shorter than 90 days.",
		"protocol", "category")

	// The peer comparison. A P/F means nothing outside its category, so the
	// median is published per category and the row's distance to it is its
	// own series rather than something a reader has to compute.
	pvCategoryMedianPF = gaugeVec("protocol_category_pf_median",
		"Median P/F of a category, over the categories with at least 5 tokens.", "category")
	pvCategorySize = gaugeVec("protocol_category_size",
		"How many tokens the category median is taken over.", "category")
	pvPFvsCategory = gaugeVec("protocol_pf_vs_category_ratio",
		"This protocol's P/F divided by its category median. Below 1 is cheaper than its peers.", "protocol")
	pvDiverging = gaugeVec("protocol_diverging",
		"1 when fees grew on the month, the token fell, and the P/F sits below the category median. A screen, not a verdict.", "protocol")

	pvIncomplete = gaugeVec("protocol_fees_incomplete",
		"1 when one of this token's fee adapters reports nothing over 30 days after real fees over the year, so the published total is short of the protocol's revenue. Such a row keeps its gauges but leaves the ranking and the category median.",
		"protocol")
	pvSilentFees1y = gaugeVec("protocol_silent_adapter_fees_1y_usd",
		"What this token's silent adapters earned over the past year, so the size of the gap is visible.", "protocol")

	// The display name belongs with the data. Reconstructing it from the
	// slug title-cased 26 of 80 rows wrongly ("Ramsesx" for RamsesX,
	// "Ether Fi" for ether.fi, "Cowswap" for CoWSwap), and the leader's
	// name is the most quoted word on the page.
	pvInfo = gaugeVec("protocol_info",
		"Always 1. Carries the protocol's display name and category as labels, so a board can be generated from the series rather than from the slug.",
		"protocol", "name", "category")

	pvHealth = gaugeVec("protocol_valuation_health",
		"1 if this protocol resolved to a token with a market cap on the last poll.", "protocol")

	// Cohort observability: the join is the fragile part, so its shape is a
	// first-class series rather than a log line.
	pvCohortSize = gauge("protocol_valuation_cohort_size",
		"Tokens on the board after every filter.")
	pvAdapters = gauge("protocol_valuation_adapters_total",
		"Fee adapters above the floor that the join considered.")
	pvUnmapped = gauge("protocol_valuation_unmapped_adapters",
		"Adapters above the floor with no token. Expected to be most of them: a protocol can earn without having something to value.")
	pvViaParent = gauge("protocol_valuation_via_parent",
		"Tokens resolved through the parent protocol rather than the adapter's own row. Without /config these would all be missing.")
	pvMerged = gauge("protocol_valuation_merged_adapters",
		"Adapters folded into a token that already had one (Uniswap V2 + V3 + V4). Ranking them apart would price one market cap several times.")
	pvPeerGroups = gauge("protocol_valuation_peer_groups",
		"Categories with enough tokens to publish a median.")
	pvLastSuccessUnix = gauge("protocol_valuation_last_success_unix",
		"Unix timestamp of the last poll that published a cohort.")
	pvFetchErrors = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "protocol_valuation_fetch_errors_total",
		Help: "Fetch failures by source.",
	}, []string{"source"})

	// The CoinGecko budget, so a reader can check the one-call-per-token
	// per-day claim against the counter rather than trust it.
	pvCoinGeckoCalls = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "protocol_valuation_coingecko_calls_total",
		Help: "CoinGecko requests made, /coins/markets and /market_chart together, retries included.",
	})
	pvCoinGecko429s = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "protocol_valuation_coingecko_429_total",
		Help: "CoinGecko responses that were a rate limit.",
	})
	pvSupplyCacheSize = gauge("protocol_valuation_supply_cache_size",
		"Tokens whose supply series is cached for the current UTC day.")
	pvCoinGeckoGap = gauge("protocol_valuation_coingecko_gap_seconds",
		"Current spacing between CoinGecko calls. Doubles on a 429, halves back after a run of clean calls.")
)

func gaugeVec(name, help string, labels ...string) *prometheus.GaugeVec {
	return prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: name, Help: help}, labels)
}

func gauge(name, help string) prometheus.Gauge {
	return prometheus.NewGauge(prometheus.GaugeOpts{Name: name, Help: help})
}

func init() {
	prometheus.MustRegister(
		pvFees30d, pvFeesPrev30d, pvAnnualFees, pvFeeGrowth,
		pvMcap, pvFDV, pvFloat, pvPriceChg,
		pvPF, pvPFfdv,
		pvRev30d, pvAnnualRev, pvPS, pvRevIncomplete, pvRevMissingAdapters, pvTVL, pvSupplyChg30d, pvSupplyChg90d,
		pvCategoryMedianPF, pvCategorySize, pvPFvsCategory, pvDiverging,
		pvIncomplete, pvSilentFees1y, pvInfo,
		pvHealth,
		pvCohortSize, pvAdapters, pvUnmapped, pvViaParent, pvMerged,
		pvPeerGroups, pvLastSuccessUnix, pvFetchErrors,
		pvCoinGeckoCalls, pvCoinGecko429s, pvSupplyCacheSize, pvCoinGeckoGap,
	)
	pvCoinGeckoGap.Set(cgMinGap.Seconds())
}

// publish writes one poll's rows. Every per-protocol vector is reset first:
// the cohort is rebuilt from upstream each tick, so a protocol that drops
// out (token delisted, fees below the floor) must lose its series rather
// than carry a stale valuation forward. That is the opposite of the
// carry-forward rule in the per-chain harnesses, and deliberately so —
// there the row is fixed and the value moves, here the row set itself is
// the measurement.
func publish(rows []Row, medians map[string]float64, sizes map[string]int, st cohortStats, now float64) {
	for _, v := range []*prometheus.GaugeVec{
		pvFees30d, pvFeesPrev30d, pvAnnualFees, pvFeeGrowth, pvMcap, pvFDV,
		pvFloat, pvPriceChg, pvPF, pvPFfdv, pvPFvsCategory, pvDiverging,
		pvRev30d, pvAnnualRev, pvPS, pvRevIncomplete, pvRevMissingAdapters, pvTVL, pvSupplyChg30d, pvSupplyChg90d,
		pvIncomplete, pvSilentFees1y, pvInfo,
		pvHealth, pvCategoryMedianPF, pvCategorySize,
	} {
		v.Reset()
	}

	for _, r := range rows {
		pvFees30d.WithLabelValues(r.Slug, r.Category).Set(r.Fees30d)
		pvFeesPrev30d.WithLabelValues(r.Slug).Set(r.Prev30d)
		pvAnnualFees.WithLabelValues(r.Slug).Set(r.AnnualFees)
		pvMcap.WithLabelValues(r.Slug).Set(r.Mcap)
		pvHealth.WithLabelValues(r.Slug).Set(1)
		pvInfo.WithLabelValues(r.Slug, r.Name, r.Category).Set(1)
		pvIncomplete.WithLabelValues(r.Slug).Set(boolGauge(r.Incomplete))
		if r.SilentFees1y > 0 {
			pvSilentFees1y.WithLabelValues(r.Slug).Set(r.SilentFees1y)
		}
		if r.FDV > 0 {
			pvFDV.WithLabelValues(r.Slug).Set(r.FDV)
		}
		if r.HasFloat {
			pvFloat.WithLabelValues(r.Slug).Set(r.FloatPct)
		}
		if r.HasFeeGrowth {
			pvFeeGrowth.WithLabelValues(r.Slug).Set(r.FeeGrowthPct)
		}
		if r.HasPriceChg {
			pvPriceChg.WithLabelValues(r.Slug).Set(r.PriceChgPct)
		}
		if r.HasPF {
			pvPF.WithLabelValues(r.Slug).Set(r.PF)
		}
		if r.HasFDV {
			pvPFfdv.WithLabelValues(r.Slug).Set(r.PFfdv)
		}
		if r.Rev30d > 0 {
			pvRev30d.WithLabelValues(r.Slug, r.Category).Set(r.Rev30d)
			pvAnnualRev.WithLabelValues(r.Slug).Set(r.AnnualRev)
			pvRevIncomplete.WithLabelValues(r.Slug).Set(boolGauge(r.RevIncomplete))
			if r.RevMissingAdapters > 0 {
				pvRevMissingAdapters.WithLabelValues(r.Slug).Set(float64(r.RevMissingAdapters))
			}
		}
		if r.HasPS {
			pvPS.WithLabelValues(r.Slug, r.Category).Set(r.PS)
		}
		if r.HasTVL {
			pvTVL.WithLabelValues(r.Slug, r.Category).Set(r.TVL)
		}
		if r.HasSupply30d {
			pvSupplyChg30d.WithLabelValues(r.Slug, r.Category).Set(r.SupplyChg30d)
		}
		if r.HasSupply90d {
			pvSupplyChg90d.WithLabelValues(r.Slug, r.Category).Set(r.SupplyChg90d)
		}
		if r.HasPF && r.HasPeerGroup && r.CategoryMedianPF > 0 {
			pvPFvsCategory.WithLabelValues(r.Slug).Set(r.PF / r.CategoryMedianPF)
		}
		if r.HasPeerGroup {
			pvDiverging.WithLabelValues(r.Slug).Set(boolGauge(r.Diverging()))
		}
	}

	for cat, m := range medians {
		pvCategoryMedianPF.WithLabelValues(cat).Set(m)
		pvCategorySize.WithLabelValues(cat).Set(float64(sizes[cat]))
	}

	pvCohortSize.Set(float64(len(rows)))
	pvAdapters.Set(float64(st.Adapters))
	pvUnmapped.Set(float64(st.Unmapped))
	pvViaParent.Set(float64(st.ViaParent))
	pvMerged.Set(float64(st.Merged))
	pvPeerGroups.Set(float64(len(medians)))
	pvLastSuccessUnix.Set(now)
}

func boolGauge(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("OK")) })
	return http.ListenAndServe(addr, mux)
}
