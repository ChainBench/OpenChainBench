package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the OCB gas estimation accuracy bench. All values
// are in **gwei** (not wei) — the float64 representation is fine
// since priority fees on the measured chains span 0.001 gwei
// (Avalanche calm) to 500+ gwei (Polygon spike) and float64 has
// ample precision across that range.
//
// Naming convention `gas_<measurement>_<unit>` matches the rest of
// the OCB suite. The spec YAML uses these directly via PromQL. Every
// metric carries a `chain` label so the leaderboard can filter to
// Ethereum / Polygon / Avalanche or aggregate across all of them.
var (
	gasPredictedPriority = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_predicted_priority_gwei",
			Help: "Most recent priority-fee prediction (gwei) emitted by an oracle for a specific tier. Updated on each oracle poll.",
		},
		[]string{"oracle", "tier", "chain"},
	)

	gasPredictedBase = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_predicted_base_gwei",
			Help: "Most recent next-block base-fee prediction (gwei) emitted by an oracle.",
		},
		[]string{"oracle", "chain"},
	)

	gasRealizedPriority = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_realized_priority_gwei",
			Help: "Realized priority-fee percentile (gwei) computed from the actual transactions in the mined block.",
		},
		[]string{"tier", "chain"},
	)

	gasRealizedBase = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_realized_base_gwei",
			Help: "Realized base fee (gwei) of the most recently observed block.",
		},
		[]string{"chain"},
	)

	gasErrorPriorityGauge = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_error_priority_gwei",
			Help: "Latest absolute error (|predicted - realized|, gwei) for the priority-fee tier prediction of a given oracle. One sample per (oracle, tier, chain) per realized block.",
		},
		[]string{"oracle", "tier", "chain"},
	)

	gasErrorPriorityHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "gas_error_priority_gwei_histogram",
			Help:    "Histogram of absolute priority-fee prediction errors per (oracle, tier, chain) — drives the p50/p90 leaderboard via `histogram_quantile` / `quantile_over_time`. Buckets span Avalanche-calm (0.001 gwei) up through Polygon-spike (100+ gwei) so the same scale works across every measured chain.",
			Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250},
		},
		[]string{"oracle", "tier", "chain"},
	)

	gasErrorBaseGauge = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_error_base_gwei",
			Help: "Latest absolute error (|predicted - realized|, gwei) for the next-block base-fee prediction. Most oracles inherit baseFee from EIP-1559 so this is mostly a sanity check, not a ranking signal.",
		},
		[]string{"oracle", "chain"},
	)

	gasOracleCallTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "gas_oracle_call_total",
			Help: "Number of oracle polls broken down by result: ok, http_err, parse_err, throttled (HTTP 429 or oracle-specific quota message).",
		},
		[]string{"oracle", "result", "chain"},
	)

	gasOracleHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_oracle_health",
			Help: "1 when the most recent poll succeeded, 0 otherwise.",
		},
		[]string{"oracle", "chain"},
	)

	gasRealizedTxCount = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_realized_tx_count",
			Help: "Transaction count of the most recently observed block. Low values (empty blocks) flag that the realized percentile may be noisy.",
		},
		[]string{"chain"},
	)

	gasPendingBufferSize = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_pending_buffer_size",
			Help: "Number of pending predictions for each (oracle, chain) still waiting on a realized block. Sustained growth signals the realizer is falling behind.",
		},
		[]string{"oracle", "chain"},
	)

	gasPredictionAge = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "gas_prediction_age_seconds",
			Help:    "Age of a prediction (wall-clock seconds between the oracle poll returning and the realized block being graded). Discloses cadence asymmetry: an oracle polled every 60s is on average ~30s stale on a 12s-block chain, which the leaderboard should surface rather than hide.",
			Buckets: []float64{1, 3, 5, 8, 12, 15, 20, 30, 45, 60, 90, 120, 180},
		},
		[]string{"oracle", "chain"},
	)

	gasRealizedQuorumDisagree = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "gas_realized_quorum_disagreement_total",
			Help: "Count of blocks where the primary realized RPC and the independent verify RPC returned different baseFeePerGas for the same block number. High values indicate one endpoint is stale or forked; used to detect whether our realized ground truth is actually independent across upstreams.",
		},
		[]string{"chain", "kind"},
	)

	// Over/under split: an inclusion-confidence oracle (over-predicts
	// on purpose) and a percentile tracker (under-predicts on tail
	// spikes) can post the same abs error but with opposite user
	// consequences — over = overpay a few wei, under = tx stuck
	// waiting for a spike to subside. Emitting the two branches as
	// separate histograms lets the leaderboard rank them independently
	// or compose them into an asymmetric loss (over-weight = 0.1,
	// under-weight = 0.9 → pinball loss at τ=0.9) without ever
	// hiding the split behind a single abs number.
	gasErrorPriorityOverHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "gas_error_priority_over_gwei_histogram",
			Help:    "Histogram of over-prediction gap (predicted − realized when predicted > realized, in gwei) per (oracle, tier, chain). Zero when the oracle under-predicts. Reads high for inclusion-confidence oracles by design (Etherscan, MetaMask 'high').",
			Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250},
		},
		[]string{"oracle", "tier", "chain"},
	)

	gasErrorPriorityUnderHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "gas_error_priority_under_gwei_histogram",
			Help:    "Histogram of under-prediction gap (realized − predicted when predicted < realized, in gwei) per (oracle, tier, chain). Zero when the oracle over-predicts. Reads high for percentile trackers during spikes (PublicNode feeHistory, Owlracle) — that's when a wrong number actually costs the user their block.",
			Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250},
		},
		[]string{"oracle", "tier", "chain"},
	)

	// Lag2 grade: the primary histogram grades a prediction against
	// the very next block, which rewards whichever oracle scraped the
	// mempool 100 ms before we did (a latency race, not accuracy).
	// This companion series grades the same prediction two blocks
	// later — closer to what a wallet UX actually delivers (sign,
	// broadcast, propagate). Same buckets so the two are directly
	// comparable via `quantile_over_time`.
	gasErrorPriorityLag2Hist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "gas_error_priority_lag2_gwei_histogram",
			Help:    "Histogram of |predicted − realized| in gwei, graded 2 blocks after the prediction's target (removes the very-next-block latency-race bias). Buckets identical to the primary histogram so they can be compared directly on the leaderboard.",
			Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250},
		},
		[]string{"oracle", "tier", "chain"},
	)

	// Asymmetric Pinball Loss at τ=0.9 (Koenker & Bassett 1978, a
	// proper scoring rule per Gneiting & Raftery 2007). Per-sample
	// value: `(1-τ) × over_gap` if predicted > realized, else
	// `τ × under_gap`. τ=0.9 encodes "under-prediction is 9× worse
	// than over-prediction" — matches real wallet UX where a stuck
	// tx is far more painful than paying 20 % over. Emitting this as
	// its own histogram (not derived from over/under histograms via
	// PromQL) lets `quantile_over_time` produce a stable per-oracle
	// APL median that can be ranked directly. Same bucket ladder as
	// the abs error hist so the two are comparable at a glance.
	gasErrorPriorityAPLHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "gas_error_priority_apl_gwei_histogram",
			Help:    "Histogram of per-sample asymmetric pinball loss (τ=0.9, gwei) per (oracle, tier, chain). Under-prediction is 9× more expensive than over-prediction, matching wallet UX where a stuck tx hurts more than a small overpay. Proper scoring rule; ranks stably at n=few-hundred where p99 abs error is still noisy.",
			Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250},
		},
		[]string{"oracle", "tier", "chain"},
	)
)

// aplTau is the asymmetric pinball loss target quantile. 0.9 encodes
// the wallet UX asymmetry: under-prediction (stuck tx) is 9× more
// costly than over-prediction (small overpay). If we ever add a
// second APL curve (e.g. τ=0.5 for symmetric ranking), give it a
// separate metric — do not overload one histogram with a tau label
// or the buckets will not align across taus.
const aplTau = 0.9

// StartMetricsServer binds /metrics + /health on addr. Blocking call —
// run in its own goroutine.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("gas-estimation harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
