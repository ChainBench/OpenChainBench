package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the Hyperliquid frontends quality bench. Names are
// prefixed `hl_frontend_` so the OCB MCP allowlist needs one entry
// (`hl_frontend_`) for every metric this harness emits.

var (
	hlEffectiveFeeBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_effective_fee_bps",
			Help: "Volume-weighted effective builder fee in basis points over the last 24h: sum(builder_fee) / sum(notional) * 10000.",
		},
		[]string{"builder"},
	)

	hlFeesPerUserUSD = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_fees_per_user_usd",
			Help: "USD fees captured per unique trader over the last 24h: sum(builder_fee_usd) / count(distinct user).",
		},
		[]string{"builder"},
	)

	hlVolumeUSD24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_volume_usd_24h",
			Help: "Total notional USD volume routed via this builder in the last 24h. Secondary signal — not the headline.",
		},
		[]string{"builder"},
	)

	hlUsers24h = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_users_24h",
			Help: "Count of unique trader addresses attributed to this builder in the last 24h.",
		},
		[]string{"builder"},
	)

	hlFillsTotal = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_fills_total",
			Help: "Count of attributed fills observed in the last 24h. Drives the leaderboard sample_size column.",
		},
		[]string{"builder"},
	)

	hlUnattributedShare = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "hl_frontend_unattributed_share_pct",
			Help: "Share of Hyperliquid builder-fee volume from addresses NOT in our registry. >2% should trigger a registry-update review.",
		},
	)

	hlRegistryAge = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "hl_frontend_registry_age_seconds",
			Help: "Seconds since the builders.json file was last modified on disk. Surfaces stale-registry drift.",
		},
	)

	hlCSVFetchStatus = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "hl_frontend_csv_fetch_status_total",
			Help: "Outcome of each fetch of the per-day Hyperliquid fills CSV, by HTTP code (200, 403=no fills that day, 5xx, error).",
		},
		[]string{"builder", "code"},
	)

	// Cohort retention — the unique OCB edge. Of the users whose first
	// observed fill for a builder lands in the 24h window {7,30} days
	// ago, the fraction that traded again in the last 24h. Requires
	// the SQLite state layer because no public source publishes it.
	hlD7Retention = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_d7_retention_pct",
			Help: "D7 cohort retention in percent: of users who first traded via this builder 7 days ago, fraction that traded again in the last 24h.",
		},
		[]string{"builder"},
	)

	hlD30Retention = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_d30_retention_pct",
			Help: "D30 cohort retention in percent: of users who first traded via this builder 30 days ago, fraction that traded again in the last 24h.",
		},
		[]string{"builder"},
	)

	hlD7CohortSize = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_d7_cohort_size",
			Help: "Number of users in the D7 cohort. Low cohort sizes (<50) make the retention percentage statistically noisy.",
		},
		[]string{"builder"},
	)

	hlD30CohortSize = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_d30_cohort_size",
			Help: "Number of users in the D30 cohort.",
		},
		[]string{"builder"},
	)

	// Volume share computed across builders in the registry. Every
	// other dashboard has this — we expose it as secondary so the
	// page still surfaces the number readers expect to see.
	hlVolumeSharePct = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "hl_frontend_volume_share_pct",
			Help: "Share in percent of the last 24h notional volume across builders in our registry. Coverage gap (= volume from unregistered addresses) surfaces in hl_frontend_unattributed_share_pct.",
		},
		[]string{"builder"},
	)
)

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("hyperliquid-frontends harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
