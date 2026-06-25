package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Prom metrics for the ACTIVE landing prober. Sit alongside the
// observational `solana_landing_*` metrics in metrics.go.
//
// Naming convention: `solana_landing_probe_<measurement>` — the `_probe_`
// infix flags series produced by the active prober so the OCB spec
// queries can target them unambiguously.
//
// The bench page surfaces:
//   • landing_rate  = success_total / (success_total + dropped{reason=timeout})
//   • p50 / p99     derived in Prom from the *_histogram series
//
// Label / metric shape is stable; any change should ship as a public PR
// with a 14-day comment window before redeploy.

var (
	// One increment per landed (confirmed) probe. Headline numerator of
	// landing_rate.
	solanaLandingProbeSuccess = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "solana_landing_probe_success_total",
			Help: "Active probes that reached confirmation_status=confirmed within the 60s timeout, per service / mode / region.",
		},
		[]string{"service", "mode", "region"},
	)

	// Drops, classified. `reason` ∈ {timeout, invalid, network_error}.
	// timeout = no confirmation within 60s (counts toward landing_rate denom)
	// invalid = service returned an RPC error or tx was rejected on-chain
	// network_error = transport/HTTP failure (excluded from headline rate)
	solanaLandingProbeDropped = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "solana_landing_probe_dropped_total",
			Help: "Active probes that did not confirm, classified by reason. timeout|invalid|network_error|rate_limited.",
		},
		[]string{"service", "mode", "region", "reason"},
	)

	// Last observed slot delta. Useful for dashboards; statistics are
	// derived from the histogram below.
	solanaLandingProbeLatencySlots = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "solana_landing_probe_latency_slots",
			Help: "Most recent observed land_slot - submit_slot for a successful probe.",
		},
		[]string{"service", "mode", "region"},
	)

	// Histogram of slot deltas — the canonical source for p50 / p99
	// landing-time published on openchainbench.com.
	solanaLandingProbeLatencySlotsHistogram = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "solana_landing_probe_latency_slots_histogram",
			Help:    "Histogram of land_slot - submit_slot for successful probes. Buckets cover normal-to-extreme tail.",
			Buckets: []float64{1, 2, 3, 5, 10, 20, 50, 100},
		},
		[]string{"service", "mode", "region"},
	)

	// Last observed wall-clock ms. Includes network RTT to the service
	// endpoint + Solana propagation. Histogram below is the source of
	// truth for the published numbers.
	solanaLandingProbeLatencyMs = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "solana_landing_probe_latency_ms",
			Help: "Most recent wall-clock milliseconds from sendTransaction return to confirmation_status=confirmed.",
		},
		[]string{"service", "mode", "region"},
	)

	solanaLandingProbeLatencyMsHistogram = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "solana_landing_probe_latency_ms_histogram",
			Help:    "Histogram of wall-clock landing latency in milliseconds for successful probes.",
			Buckets: []float64{100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000},
		},
		[]string{"service", "mode", "region"},
	)

	// Prober keypair balance in SOL. Alert below 0.3 SOL: the keypair
	// needs a manual top-up before probes start failing on insufficient
	// funds (which would silently bias the bench against premium-tip
	// services first).
	solanaLandingProbeKeypairBalanceSOL = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "solana_landing_probe_keypair_balance_sol",
			Help: "Probe keypair balance in SOL, refreshed at the start of every cycle.",
		},
		[]string{"region"},
	)

	// Counter incremented every cycle that we SKIP because the keypair
	// balance is below the safety threshold. The bench would otherwise
	// silently bias against premium-tip services (which deplete the
	// keypair fastest) — so we skip the whole cycle once we cross the
	// threshold and let Florent top up. Pair with an alert on rate>0.
	solanaLandingProbeKeypairLowBalanceTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "solana_landing_probe_keypair_low_balance_total",
			Help: "Cycles skipped because keypair balance fell below the safety threshold (minProbeBalanceLamports).",
		},
		[]string{"region"},
	)

	// 1 when the prober goroutine is configured and running, 0 when
	// the harness is in pure observational mode (SOLANA_PROBE_KEYPAIR_BASE58
	// unset). Lets dashboards distinguish "no data because prober off"
	// from "no data because prober stuck".
	solanaLandingProbeEnabled = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "solana_landing_probe_enabled",
			Help: "1 if the active prober is configured and running, 0 otherwise.",
		},
		[]string{"region"},
	)

	// Counter incremented at the END of every cycle (after all per-service
	// probes have either landed or timed out). Pair with
	// last_cycle_timestamp to detect a stalled prober.
	solanaLandingProbeCycleTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "solana_landing_probe_cycle_total",
			Help: "Probe cycles completed (success or timeout). One increment per cycle, per region.",
		},
		[]string{"region"},
	)

	solanaLandingProbeLastCycleTimestamp = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "solana_landing_probe_last_cycle_timestamp_seconds",
			Help: "Unix timestamp of the most recent completed probe cycle. Use against time() to alert on stalled prober.",
		},
		[]string{"region"},
	)
)
