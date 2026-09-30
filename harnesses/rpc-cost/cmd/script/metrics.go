package main

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics emitted by the rpc-cost harness.
//
//   rpc_cost_monthly_usd{provider, plan, kind, bucket, chain, cohort, venue}
//     The monthly bill in USD for that workload at that volume, on the
//     provider's cheapest eligible plan. Lower is better.
//
//   rpc_cost_per_million_usd{provider, plan, kind, bucket, chain, cohort, venue}
//     The same bill expressed per million requests. Derived, not a
//     published rate: a plan that bundles more than the workload uses
//     shows a high effective rate here, which is the honest reading.
//
//   rpc_cost_units_per_request{provider, kind, chain}
//     Weighted billing units one request of this profile costs. This is
//     what makes a Compute Unit, a Request Unit and a credit comparable,
//     and it is published so a reader can redo the arithmetic.
//
//   rpc_cost_eligible{provider, kind, bucket}
//     1 when the provider can serve this workload at all, 0 when no plan
//     qualifies (daily cap too low, no archive, no trace, hard stop).
//     A zero here is a finding, not missing data.
//
//   rpc_cost_breakeven_requests{provider, plan}
//     For the dedicated cohort: monthly request count at which the fixed
//     monthly price undercuts the cheapest metered rate.
//
//   rpc_pricing_artifact_ok{provider, artifact}
//     1 when the upstream pricing artifact still answers.
//
//   rpc_pricing_artifact_age_seconds{provider, artifact}
//     Seconds since a human last verified the figures under that
//     artifact. The bench page ages its own numbers in public.
//
//   rpc_pricing_artifact_drift{provider, artifact}
//     1 when the artifact's body no longer matches the hash recorded at
//     verification time, i.e. the provider changed something and the
//     catalogue has not caught up.

var (
	costMonthly    *prometheus.GaugeVec
	costPerMillion *prometheus.GaugeVec
	freeAllowance  *prometheus.GaugeVec
	planConfidence *prometheus.GaugeVec
	unitsPerReq    *prometheus.GaugeVec
	eligible       *prometheus.GaugeVec
	breakevenReqs  *prometheus.GaugeVec
	artifactOK     *prometheus.GaugeVec
	artifactAge    *prometheus.GaugeVec
	artifactDrift  *prometheus.GaugeVec
	lastRun        prometheus.Gauge
)

func init() {
	// The `venue` label carries the PLAN TIER (free/entry/growth/business/
	// enterprise, plus "all" for the unrestricted view). It is named
	// `venue` because that is an existing dimension key the site already
	// plumbs end to end; adding a `plan` key would have meant editing
	// eight files shared by 240 other benches for a cosmetic gain.
	// benchmarks/rpc-cost.yml maps it back to a "Plan" selector.
	costMonthly = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_cost_monthly_usd",
		Help: "Monthly USD bill for a workload profile at a given request volume, on the cheapest eligible plan in the tier (lower is better). `venue` is the plan tier.",
	}, []string{"provider", "plan", "kind", "bucket", "chain", "cohort", "venue"})
	prometheus.MustRegister(costMonthly)

	costPerMillion = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_cost_per_million_usd",
		Help: "Effective USD per million requests for a workload profile at a given volume. Derived from the monthly bill, not a published rate. `venue` is the plan tier.",
	}, []string{"provider", "plan", "kind", "bucket", "chain", "cohort", "venue"})
	prometheus.MustRegister(costPerMillion)

	freeAllowance = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_free_allowance_requests",
		Help: "Requests of this workload profile a provider's free tier buys per month. Free tiers all cost $0, so this is the only axis they can be ranked on (higher is better).",
	}, []string{"provider", "plan", "kind", "chain"})
	prometheus.MustRegister(freeAllowance)

	planConfidence = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_cost_plan_confidence",
		Help: "1 when the winning plan's price is verified against a primary source, 0 when it is published but carries an unresolved caveat. A cell at 0 is ranked but must be badged.",
	}, []string{"provider", "plan", "kind", "bucket"})
	prometheus.MustRegister(planConfidence)

	unitsPerReq = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_cost_units_per_request",
		Help: "Weighted billing units (CU/RU/credits/requests) charged for one request of this profile.",
	}, []string{"provider", "kind", "chain"})
	prometheus.MustRegister(unitsPerReq)

	eligible = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_cost_eligible",
		Help: "1 when the provider has a plan that can serve this workload at this volume, 0 when none qualifies.",
	}, []string{"provider", "kind", "bucket"})
	prometheus.MustRegister(eligible)

	breakevenReqs = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_cost_breakeven_requests",
		Help: "Monthly requests at which a fixed-price dedicated offering undercuts the cheapest metered rate.",
	}, []string{"provider", "plan", "chain"})
	prometheus.MustRegister(breakevenReqs)

	artifactOK = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_pricing_artifact_ok",
		Help: "1 when the upstream pricing artifact still answers over HTTP.",
	}, []string{"provider", "artifact"})
	prometheus.MustRegister(artifactOK)

	artifactAge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_pricing_artifact_age_seconds",
		Help: "Seconds since a human last verified the catalogue figures sourced from this artifact.",
	}, []string{"provider", "artifact"})
	prometheus.MustRegister(artifactAge)

	artifactDrift = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rpc_pricing_artifact_drift",
		Help: "1 when the artifact body no longer matches the hash recorded when the catalogue was last verified.",
	}, []string{"provider", "artifact"})
	prometheus.MustRegister(artifactDrift)

	lastRun = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "rpc_cost_last_run_timestamp_seconds",
		Help: "Unix time of the last completed harness cycle.",
	})
	prometheus.MustRegister(lastRun)
}
