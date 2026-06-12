package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// All v2 metrics use the `builder` label name to stay consistent with the v1
// bucket-fetch harness query patterns. The v1 service emits the same metric
// names without the _v2 suffix; both coexist in Prom during A/B.

var (
	hlVolumeUSD24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_volume_usd_24h_v2",
			Help: "Rolling 24h notional volume in USD per HL builder (local node source)",
		},
		[]string{"builder"},
	)

	hlFeesUSD24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_fees_usd_24h_v2",
			Help: "Rolling 24h builder-fee revenue in USD per HL builder (local node source)",
		},
		[]string{"builder"},
	)

	hlVolumeUSD7d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_volume_usd_7d_v2",
			Help: "Rolling 7d notional volume in USD per HL builder (hourly bucket sum)",
		},
		[]string{"builder"},
	)

	hlVolumeUSD30d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_volume_usd_30d_v2",
			Help: "Rolling 30d notional volume in USD per HL builder (hourly bucket sum)",
		},
		[]string{"builder"},
	)

	hlFeesUSD7d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_fees_usd_7d_v2",
			Help: "Rolling 7d builder-fee revenue in USD per HL builder (hourly bucket sum)",
		},
		[]string{"builder"},
	)

	hlFeesUSD30d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_fees_usd_30d_v2",
			Help: "Rolling 30d builder-fee revenue in USD per HL builder (hourly bucket sum)",
		},
		[]string{"builder"},
	)

	hlUsers24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_users_24h_v2",
			Help: "Unique users that traded through this builder in the last 24h",
		},
		[]string{"builder"},
	)

	// 7d/30d unique users from per-UTC-day wallet sets. Deliberately NOT
	// zero-initialised in registerMetrics: the series stays absent until
	// the one-shot disk backfill seeds the day sets, so a fresh restart
	// can't publish lowball counts that a dashboard would read as a user
	// exodus. 30d is limited by node file retention (counts grow until
	// 30 full days of fills exist on disk, same caveat as fees_30d).
	hlUsers7d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_users_7d_v2",
			Help: "Unique users that traded through this builder over the last 7 UTC days (union of daily wallet sets)",
		},
		[]string{"builder"},
	)

	hlUsers30d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_users_30d_v2",
			Help: "Unique users that traded through this builder over the last 30 UTC days (union of daily wallet sets, bounded by node file retention)",
		},
		[]string{"builder"},
	)

	hlFillsTotal24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_fills_total_24h_v2",
			Help: "Count of fills attributed to this builder in the last 24h",
		},
		[]string{"builder"},
	)

	hlEffectiveFeeBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_effective_fee_bps_v2",
			Help: "Builder fees / notional volume in bps over the last 24h (user-perspective cost)",
		},
		[]string{"builder"},
	)

	hlFeesPerUserUSD = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_fees_per_user_usd_v2",
			Help: "Builder fees / unique users over the last 24h (per-user ARPU)",
		},
		[]string{"builder"},
	)

	// BANGER №1: outage / freshness
	hlLastFillAgeSeconds = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_last_fill_age_seconds_v2",
			Help: "Seconds since this builder's most recent fill — outage detector",
		},
		[]string{"builder"},
	)

	hlFillsPerMin = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_fills_per_min_v2",
			Help: "Rate of fills per minute for this builder, averaged over the rolling 24h window",
		},
		[]string{"builder"},
	)

	// BANGER №2: price deviation (slippage proxy)
	hlPriceDeviationBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_price_deviation_bps_v2",
			Help: "Mean |fill_px - last_trade_px_same_asset| in bps. Proxy for slippage / execution quality. Lower = better.",
		},
		[]string{"builder"},
	)

	// BANGER №3: maker / taker split. crossed=true ⇒ taker; false ⇒ maker.
	hlTakerPct = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_taker_pct_v2",
			Help: "Share of this builder's fills (0..1) that were takers (crossed the spread)",
		},
		[]string{"builder"},
	)

	// BANGER №4: per-asset top-3 dominance. 8 builders × 3 ranks = 24 series.
	hlAssetVolumeTopUSD = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_asset_volume_top_usd_v2",
			Help: "USD volume in the rolling 24h for the top-N asset traded via this builder (rank=1 is #1)",
		},
		[]string{"builder", "asset", "rank"},
	)

	hlLastTickUnix = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "hl_frontend_local_last_tick_unix_v2",
			Help: "Unix timestamp of the last successful aggregate refresh (harness liveness)",
		},
	)

	// HIP-3 deployer metrics. The `dex` label is the coin namespace prefix
	// ("xyz:AAPL" → "xyz"); the set is dynamic (no registry) because HIP-3
	// deployment is permissionless and cardinality is naturally low (one
	// label value per staked deployer). Not zero-initialised: a dex series
	// appears with its first observed fill. users_7d/30d share the
	// usersSeeded gate with the builder metrics.
	hip3FeesUSD24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_fees_usd_24h",
			Help: "Rolling 24h deployer-fee revenue in USD per HIP-3 dex (local node source)",
		},
		[]string{"dex"},
	)
	hip3FeesUSD7d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_fees_usd_7d",
			Help: "Rolling 7d deployer-fee revenue in USD per HIP-3 dex (hourly bucket sum)",
		},
		[]string{"dex"},
	)
	hip3FeesUSD30d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_fees_usd_30d",
			Help: "Rolling 30d deployer-fee revenue in USD per HIP-3 dex (hourly bucket sum, bounded by node file retention)",
		},
		[]string{"dex"},
	)
	hip3VolumeUSD24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_volume_usd_24h",
			Help: "Rolling 24h notional volume in USD per HIP-3 dex",
		},
		[]string{"dex"},
	)
	hip3VolumeUSD7d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_volume_usd_7d",
			Help: "Rolling 7d notional volume in USD per HIP-3 dex (hourly bucket sum)",
		},
		[]string{"dex"},
	)
	hip3VolumeUSD30d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_volume_usd_30d",
			Help: "Rolling 30d notional volume in USD per HIP-3 dex (hourly bucket sum, bounded by node file retention)",
		},
		[]string{"dex"},
	)
	hip3Users24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_users_24h",
			Help: "Unique wallets that traded on this HIP-3 dex in the last 24h (hourly set union)",
		},
		[]string{"dex"},
	)
	hip3Users7d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_users_7d",
			Help: "Unique wallets that traded on this HIP-3 dex over the last 7 UTC days (union of daily wallet sets)",
		},
		[]string{"dex"},
	)
	hip3Users30d = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_users_30d",
			Help: "Unique wallets that traded on this HIP-3 dex over the last 30 UTC days (union of daily wallet sets, bounded by node file retention)",
		},
		[]string{"dex"},
	)
	hip3Fills24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_fills_24h",
			Help: "Count of fills on this HIP-3 dex in the last 24h",
		},
		[]string{"dex"},
	)
	hip3Markets24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_markets_24h",
			Help: "Distinct markets traded on this HIP-3 dex in the last 24h",
		},
		[]string{"dex"},
	)
	hip3EffectiveFeeBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_effective_fee_bps",
			Help: "Deployer fees / notional volume in bps over the last 24h (trader-perspective cost of the dex)",
		},
		[]string{"dex"},
	)
	hip3LastFillAgeSeconds = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_hip3_deployer_last_fill_age_seconds",
			Help: "Seconds since this HIP-3 dex's most recent fill — outage detector",
		},
		[]string{"dex"},
	)
)

func registerMetrics(builders []Builder) {
	for _, b := range builders {
		hlVolumeUSD24h.WithLabelValues(b.Slug).Set(0)
		hlFeesUSD24h.WithLabelValues(b.Slug).Set(0)
		hlVolumeUSD7d.WithLabelValues(b.Slug).Set(0)
		hlVolumeUSD30d.WithLabelValues(b.Slug).Set(0)
		hlFeesUSD7d.WithLabelValues(b.Slug).Set(0)
		hlFeesUSD30d.WithLabelValues(b.Slug).Set(0)
		hlUsers24h.WithLabelValues(b.Slug).Set(0)
		hlFillsTotal24h.WithLabelValues(b.Slug).Set(0)
		hlEffectiveFeeBps.WithLabelValues(b.Slug).Set(0)
		hlFeesPerUserUSD.WithLabelValues(b.Slug).Set(0)
		hlLastFillAgeSeconds.WithLabelValues(b.Slug).Set(0)
		hlFillsPerMin.WithLabelValues(b.Slug).Set(0)
		hlPriceDeviationBps.WithLabelValues(b.Slug).Set(0)
		hlTakerPct.WithLabelValues(b.Slug).Set(0)
	}
}
