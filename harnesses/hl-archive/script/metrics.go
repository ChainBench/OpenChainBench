// metrics.go — Prometheus metric registration.
//
// All metrics are package-level vars so any handler can update them
// without passing a registry around. Names follow the
// `hl_archive_*` namespace agreed in the spec; do not rename without
// updating the dashboards.
package script

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	MetricLastRun = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_archive_last_run_unix_seconds",
		Help: "Unix timestamp of the last completed daily run (any result).",
	})

	MetricFilesProcessed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "hl_archive_files_processed_total",
		Help: "Number of CDN CSV files processed, by source and result.",
	}, []string{"source", "result"})

	MetricDBSize = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_archive_db_size_bytes",
		Help: "Size of the DuckDB file on disk.",
	})

	MetricBuildersCount = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_archive_builders_count",
		Help: "Number of distinct builders with at least one aggregate row.",
	})

	MetricDaysCount = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_archive_days_count",
		Help: "Number of distinct days in builder_daily_aggregates.",
	})

	MetricLagHours = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_archive_lag_hours",
		Help: "Hours between now and the most recent processed day.",
	})

	MetricUpstashPushDur = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "hl_archive_upstash_push_duration_seconds",
		Help:    "Duration of Upstash REST push calls.",
		Buckets: prometheus.DefBuckets,
	})

	MetricCronRuns = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "hl_archive_cron_runs_total",
		Help: "Internal daily-cron firings, by result (ok|err).",
	}, []string{"result"})

	MetricHTTPRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "hl_archive_http_requests_total",
		Help: "HTTP requests served by the API.",
	}, []string{"path", "code"})
)

// Trader-leaderboard audit gauges. One snapshot of the venue's published
// table per run; every figure is a count or a sum over its rows, so a
// reader can recompute all of them from the same public blob.
var (
	MetricTradersAccounts = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_accounts",
		Help: "Accounts present in Hyperliquid's published leaderboard blob.",
	})

	MetricTradersWinnersPct = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_winners_pct",
		Help: "Share of published accounts with all-time PnL above zero. Perp PnL is zero-sum net of fees, so a majority in profit means the published set is not the population.",
	})

	MetricTradersAggPnL = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_agg_pnl_usd",
		Help: "Sum of all-time PnL across every published account. Positive by the same argument as hl_traders_winners_pct.",
	})

	MetricTradersAggEquity = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_agg_equity_usd",
		Help: "Sum of current account equity across every published account.",
	})

	MetricTradersAggVlm = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_agg_vlm_usd",
		Help: "Sum of all-time volume across every published account. Counts perp notional only, unlike the PnL field beside it.",
	})

	MetricTradersZeroVlmAccounts = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_zero_volume_accounts",
		Help: "Accounts publishing a non-zero all-time PnL against exactly zero all-time volume: the seam between the two fields.",
	})

	MetricTradersZeroVlmPnL = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_zero_volume_pnl_usd",
		Help: "Summed all-time PnL of the zero-volume cohort, in USD.",
	})

	MetricTradersZeroVlmPnLPct = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_zero_volume_pnl_pct",
		Help: "The zero-volume cohort's share of the leaderboard's aggregate PnL.",
	})

	MetricTradersTop100PnLPct = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_top100_pnl_pct",
		Help: "Share of aggregate all-time PnL carried by the hundred highest rows.",
	})

	MetricTradersROIOutliers = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_roi_outliers",
		Help: "Accounts whose published ROI exceeds 10,000 % in absolute value. ROI ships without its denominator, so it is not comparable across rows at any value.",
	})

	MetricTradersNonPerpPnLPct = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_non_perp_pnl_pct",
		Help: "Share of lifetime PnL that the perp-only window does not claim (spot, vaults, staking), across the highest-PnL accounts sampled from the info API portfolio request. Read it as a property of the rows the leaderboard showcases, never of the population: sampling the top by PnL selects for the zero-volume cohort by construction. Pair it with hl_traders_sampled_accounts.",
	})

	MetricTradersSampled = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_sampled_accounts",
		Help: "Accounts successfully read from the info API portfolio endpoint on the last run.",
	})

	MetricTradersPortfolioErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "hl_traders_portfolio_errors_total",
		Help: "Failed info API portfolio reads, cumulative.",
	})

	MetricTradersMalformedRows = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_malformed_rows",
		Help: "Leaderboard rows whose lifetime window was absent or unreadable. Expected zero; non-zero means the published blob's shape moved and every other hl_traders_* figure needs re-reading before it is quoted.",
	})

	MetricTradersLastRun = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hl_traders_last_run_unix_seconds",
		Help: "Unix timestamp of the last completed trader-leaderboard audit.",
	})
)
