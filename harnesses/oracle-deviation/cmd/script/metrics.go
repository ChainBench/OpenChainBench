package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the OCB Oracle Deviation bench (№ 025). Naming
// follows the `ocb_oracle_<measurement>` convention; the OCB site
// derives the per-pair / per-source leaderboard directly from these
// gauges via PromQL.
var (
	oraclePrice = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_price",
			Help: "Most recent USD price reported by an oracle for a pair. USDT is treated as ≈ USD (Binance only quotes USDT).",
		},
		[]string{"source", "pair"},
	)

	// Legacy fetch-time pairwise deviation. Each (source_a, source_b)
	// is compared at whatever time we last fetched them, ignoring
	// each source's own update timestamp. Preserved as the original
	// gauge name for backward compatibility with anyone consuming
	// the bench's PromQL surface today.
	oracleDeviationPct = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_deviation_pct",
			Help: "Legacy fetch-time pairwise deviation between two sources (alias of ocb_oracle_deviation_at_fetch_ts_pct, preserved for backward compat). Use ocb_oracle_deviation_at_oracle_ts_pct for the canonical time-aligned number.",
		},
		[]string{"pair", "source_a", "source_b"},
	)

	// Explicit fetch-time variant: same value as the legacy gauge,
	// renamed so dashboards can disambiguate from the at_oracle_ts
	// canonical metric. Both are kept so people who built on the
	// legacy name don't break.
	oracleDeviationAtFetchTSPct = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_deviation_at_fetch_ts_pct",
			Help: "Fetch-time pairwise deviation. Each source's last-fetched price, regardless of when the source said the price was current. Includes Chainlink's heartbeat lag as 'deviation' (operational truth, not oracle-quality).",
		},
		[]string{"pair", "source_a", "source_b"},
	)

	// THE canonical headline-feeding gauge. Each (source_a, source_b)
	// compared at the more recent of their two SourceTSs (Chainlink's
	// on-chain updatedAt for chainlink, fetch time for the others).
	// The OTHER source's price is looked up in a 30 min rolling
	// history buffer at the anchor moment via lookupNearest. When the
	// anchor falls outside the history window the pair is skipped
	// for this update and oracleAlignmentMiss is incremented.
	oracleDeviationAtOracleTSPct = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_deviation_at_oracle_ts_pct",
			Help: "Time-aligned pairwise deviation. Each source's price snapped to the more recent SourceTS of the pair (Chainlink's on-chain updatedAt for chainlink, fetch time for continuous sources), with the older source's price looked up from history. This is the canonical deviation: it answers 'do the oracles agree at the same moment in time' instead of 'do they agree at our fetch instant'.",
		},
		[]string{"pair", "source_a", "source_b"},
	)

	// Counter for pairs where the time-aligned calc couldn't find a
	// history sample within alignTolerance of the anchor. Expected to
	// fire during cold start (first 5 min after deploy) and when a
	// Chainlink updatedAt lands further back than historyDepth (60
	// samples × 30s ≈ 30 min). A persistently high miss rate flags
	// a source whose history isn't being kept dense enough.
	oracleAlignmentMiss = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ocb_oracle_alignment_miss_total",
			Help: "Pairwise computations where no history sample was within ±10s of the anchor SourceTS for at least one of the two sources. Pair is skipped on the at_oracle_ts gauge for that cycle.",
		},
		[]string{"pair", "source_a", "source_b"},
	)

	oracleMaxDeviationPct = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_max_deviation_pct",
			Help: "Maximum pairwise deviation across all available source pairs for the asset. The headline metric. Ranks on the time-aligned variant (ocb_oracle_deviation_at_oracle_ts_pct) when at least one pair is alignable, falls back to fetch-time during cold start.",
		},
		[]string{"pair"},
	)

	oracleUpdateLatencySeconds = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_update_latency_seconds",
			Help: "Seconds since the most recent successful update for (source, pair). Useful to flag a stalled poller before the price drifts.",
		},
		[]string{"source", "pair"},
	)

	oracleScrapeErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ocb_oracle_scrape_errors_total",
			Help: "Number of failed scrape attempts per (source, pair). Bucket-only counter, classification is logged but not labeled to keep cardinality bounded.",
		},
		[]string{"source", "pair"},
	)

	oracleLastRoundAge = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_last_round_age_seconds",
			Help: "Seconds elapsed since the oracle's own internal updatedAt timestamp. Only emitted for sources that expose one (currently Chainlink's latestRoundData.updatedAt).",
		},
		[]string{"source", "pair"},
	)
)

// StartMetricsServer binds /metrics + /health on addr. Blocking call —
// run in its own goroutine. /health returns 200 ok unconditionally;
// the harness considers itself healthy as long as the metrics server
// itself is up — individual source failures are reflected in the
// scrape_errors_total counter, not in the healthcheck.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("oracle-deviation harness · OpenChainBench № 025"))
	})
	return http.ListenAndServe(addr, mux)
}
