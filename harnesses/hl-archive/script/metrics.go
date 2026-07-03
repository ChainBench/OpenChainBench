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
