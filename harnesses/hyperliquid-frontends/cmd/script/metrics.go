package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Builder gauges keep the `_v2` names and the `builder` label of the
// node-fed harness they replace, so the site's specs, the /hyperliquid hub
// and the recorded history stay continuous. "24h" now means the last
// complete UTC day published on the feed, not a rolling window: every
// builder is measured on the same day (see hl_frontend_data_day_unix_v2).
var (
	gauge = func(name, help string, labels ...string) *prometheus.GaugeVec {
		return promauto.NewGaugeVec(prometheus.GaugeOpts{Name: name, Help: help}, labels)
	}

	hlFeesUSD24h   = gauge("hl_frontend_fees_usd_24h_v2", "Builder-fee revenue in USD on the last complete UTC feed day (hl_frontend_data_day_unix_v2).", "builder")
	hlFeesUSD7d    = gauge("hl_frontend_fees_usd_7d_v2", "Builder-fee revenue in USD over the 7 complete UTC days ending on the feed day.", "builder")
	hlFeesUSD30d   = gauge("hl_frontend_fees_usd_30d_v2", "Builder-fee revenue in USD over the 30 complete UTC days ending on the feed day.", "builder")
	hlVolumeUSD24h = gauge("hl_frontend_volume_usd_24h_v2", "Notional volume in USD (px times sz) routed on the last complete UTC feed day.", "builder")
	hlVolumeUSD7d  = gauge("hl_frontend_volume_usd_7d_v2", "Notional volume in USD over the 7 complete UTC days ending on the feed day.", "builder")
	hlVolumeUSD30d = gauge("hl_frontend_volume_usd_30d_v2", "Notional volume in USD over the 30 complete UTC days ending on the feed day.", "builder")
	hlUsers24h     = gauge("hl_frontend_users_24h_v2", "Unique wallets with at least one attributed fill on the last complete UTC feed day.", "builder")
	hlUsers7d      = gauge("hl_frontend_users_7d_v2", "Unique wallets over the 7 complete UTC days ending on the feed day (union of daily wallet sets).", "builder")
	hlUsers30d     = gauge("hl_frontend_users_30d_v2", "Unique wallets over the 30 complete UTC days ending on the feed day (union of daily wallet sets).", "builder")
	hlFills24h     = gauge("hl_frontend_fills_total_24h_v2", "Attributed fills on the last complete UTC feed day.", "builder")
	hlEffFeeBps    = gauge("hl_frontend_effective_fee_bps_v2", "Builder fees divided by notional, in bps, on the feed day (trader-perspective cost).", "builder")
	hlFeesPerUser  = gauge("hl_frontend_fees_per_user_usd_v2", "Builder fees divided by unique wallets on the feed day.", "builder")
	hlTakerPct     = gauge("hl_frontend_taker_pct_v2", "Share (0..1) of the feed day's fills that crossed the spread (taker).", "builder")
	hlCohortShare  = gauge("hl_frontend_global_volume_share_24h_v2", "This builder's share (0..1) of the feed day's notional summed across every tracked builder. The denominator is the cohort, not chain-wide volume.", "builder")
	hlRevenueDelta = gauge("hl_frontend_revenue_delta_pct_v2", "Builder-fee revenue delta versus the prior equal-length window, as a fraction (+1.0 = +100%). window: 24h, 7d, 30d. 0 when the prior window had no revenue.", "builder", "window")
	hlBiggestDay   = gauge("hl_frontend_biggest_day_revenue_usd_v2", "Highest single UTC-day builder-fee revenue in the ledger (feed history since the ledger start).", "builder")
	hlBiggestDayAt = gauge("hl_frontend_biggest_day_unix_v2", "UTC day floor (unix seconds) of the builder's biggest revenue day.", "builder")
	hlMilestone    = gauge("hl_frontend_milestone_revenue_days_v2", "Days from the builder's first ledger day with fills to the first day cumulative builder-fee revenue crossed the threshold (10k, 100k, 1m). -1 when not reached.", "builder", "threshold")
	hlProfitable   = gauge("hl_frontend_profitable_user_pct_30d_v2", "Share (0..1) of the 30-day active wallets whose summed closed_pnl on this builder's fills is positive. Realized only.", "builder")
	hlPercentile   = gauge("hl_frontend_volume_by_percentile_30d_v2", "Share (0..1) of the builder's 30-day notional contributed by wallets in the rank bucket: top1, p1_5, p5_10, p10_25, p25_50, rest.", "builder", "bucket")
	hlCoinShare    = gauge("hl_frontend_coin_volume_share_24h_v2", "Share (0..1) of the feed day's notional per coin, top 15 coins plus 'other'.", "builder", "coin")

	hlDataDay = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_frontend_data_day_unix_v2",
		Help: "UTC midnight (unix seconds) that opens the feed day the 24h gauges describe.",
	})
	hlDataDayEnd = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_frontend_data_day_end_unix_v2",
		Help: "UTC midnight (unix seconds) that closes the feed day the 24h gauges describe. Data freshness = now minus this.",
	})
	hlLastTickUnix = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_frontend_local_last_tick_unix_v2",
		Help: "Unix time of the last successful feed sync and publish (harness liveness).",
	})
	hlMirrorFiles = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_frontend_feed_files_present",
		Help: "Number of (builder address, day) CSVs in the local mirror for the 30-day window.",
	})
	hlLedgerComplete = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_frontend_ledger_complete",
		Help: "1 once the daily ledger covers every day from the ledger start to the mirror window, 0 while the one-off backfill runs.",
	})
	feedFetchTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "hl_frontend_feed_fetch_total",
		Help: "Feed downloads by outcome: ok, absent (403, no file), retry (5xx/429/transport, retried), error.",
	}, []string{"result"})

	// HIP-3 dexes, from the chain's own info API (perpDexs + metaAndAssetCtxs).
	hip3Volume24h   = gauge("hl_hip3_deployer_volume_usd_24h", "Rolling 24h notional volume in USD across the dex's markets, as reported by the Hyperliquid info API (dayNtlVlm summed).", "dex")
	hip3Volume7d    = gauge("hl_hip3_deployer_volume_usd_7d", "Sum of the dex's daily 24h-volume samples over the last 7 UTC days (one sample per day, taken right after midnight UTC).", "dex")
	hip3Volume30d   = gauge("hl_hip3_deployer_volume_usd_30d", "Sum of the dex's daily 24h-volume samples over the last 30 UTC days (grows toward the full window while samples accumulate).", "dex")
	hip3Markets24h  = gauge("hl_hip3_deployer_markets_24h", "Markets on the dex with non-zero notional volume over the rolling 24h.", "dex")
	hip3Listed      = gauge("hl_hip3_deployer_markets_listed", "Markets currently listed on the dex (delisted excluded).", "dex")
	hip3OpenInt     = gauge("hl_hip3_deployer_open_interest_usd", "Open interest in USD across the dex's markets (open interest in base units times mark price).", "dex")
	hip3DaysSampled = gauge("hl_hip3_deployer_days_sampled", "Number of daily volume samples behind the 7d/30d sums.", "dex")
	hip3Info        = gauge("hl_hip3_deployer_info", "Always 1. Carries the dex's on-chain full name and deployer address from perpDexs.", "dex", "full_name", "deployer")
	hip3LastTick    = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_hip3_last_tick_unix",
		Help: "Unix time of the last successful HIP-3 info API poll.",
	})
)
