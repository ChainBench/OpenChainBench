package main

import "github.com/prometheus/client_golang/prometheus"

// Metrics emitted by the server-wallet-cost harness.
//
//   server_wallet_cost_monthly_usd{provider, plan, kind, bucket}
//     The monthly bill on the provider's cheapest eligible plan for a
//     workload profile (kind) at a MAU volume (bucket). Lower is better.
//     The headline slice is published a second time under kind="all" and
//     bucket="all", because the site's unfiltered view selects those and
//     REPLACES them when a reader picks a tab. Averaging a bill across
//     profiles would describe no workload, so "all" is the headline slice
//     and the spec's dimension labels say which one.
//
//   server_wallet_cost_per_tx_usd{provider, plan, kind, bucket}
//     The same bill divided by the month's transactions.
//
//   server_wallet_cost_eligible{provider, kind, bucket}
//     1 when a published plan serves the volume, 0 when none does (a cap,
//     or a price only on request). A zero is a finding, not missing data.
//
//   server_wallet_cost_plan_confidence{provider, plan, kind, bucket}
//     1 when the winning plan's price rests on unambiguous published
//     figures, 0 when it carries a stated caveat. A 0 is ranked; the calculator
//     badges it and the methodology names the alternative reading.
//
//   server_wallet_pricing_artifact_ok / _drift / _age_seconds{provider, artifact}
//     Source page reachable, pricing lines changed since a human read them,
//     and seconds since that reading. Maintainer signals.
//
//   server_wallet_cost_catalogue_info{sha256, as_of} 1
//     Which catalogue this process is pricing from. The site's calculator
//     reads a curve that records the sha256 of the catalogue it was built
//     from; the catalogue ships inside this image, so a merged price change
//     reaches the site at once and this harness only after a rebuild. When
//     the two hashes differ the bench page shows two prices for one vendor.
//
//   server_wallet_cost_site_curve_matches{branch}
//     The same comparison done by the harness itself, against the curve on
//     each site branch (dev = staging, main = production). Alerted on.

var (
	costMonthly      *prometheus.GaugeVec
	costPerTx        *prometheus.GaugeVec
	eligible         *prometheus.GaugeVec
	planConfidence   *prometheus.GaugeVec
	artifactOK       *prometheus.GaugeVec
	artifactDrift    *prometheus.GaugeVec
	artifactAge      *prometheus.GaugeVec
	lastRun          prometheus.Gauge
	catalogueInfo    *prometheus.GaugeVec
	siteCurveMatches *prometheus.GaugeVec
)

func init() {
	costMonthly = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "server_wallet_cost_monthly_usd",
		Help: "Monthly USD bill on the provider's cheapest eligible plan, per scenario (kind) and size (bucket). Lower is better.",
	}, []string{"provider", "plan", "kind", "bucket"})
	costPerTx = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "server_wallet_cost_per_tx_usd",
		Help: "The monthly bill divided by the month's transactions. Derived, not a published rate.",
	}, []string{"provider", "plan", "kind", "bucket"})
	eligible = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "server_wallet_cost_eligible",
		Help: "1 when a published plan serves this workload at this volume, 0 when none does.",
	}, []string{"provider", "kind", "bucket"})
	planConfidence = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "server_wallet_cost_plan_confidence",
		Help: "1 when the winning plan's price is unambiguous, 0 when it carries a stated caveat.",
	}, []string{"provider", "plan", "kind", "bucket"})
	artifactOK = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "server_wallet_pricing_artifact_ok",
		Help: "1 when the source pricing page answered with pricing lines this cycle.",
	}, []string{"provider", "artifact"})
	artifactDrift = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "server_wallet_pricing_artifact_drift",
		Help: "1 when the page's pricing lines no longer hash to the value recorded when a human last read it.",
	}, []string{"provider", "artifact"})
	artifactAge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "server_wallet_pricing_artifact_age_seconds",
		Help: "Seconds since a human last verified the figures sourced from this page.",
	}, []string{"provider", "artifact"})
	lastRun = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "server_wallet_cost_last_run_timestamp_seconds",
		Help: "Unix time of the last completed harness cycle.",
	})
	catalogueInfo = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "server_wallet_cost_catalogue_info",
		Help: "1, labelled with the sha256 and as_of of the catalogue this process prices from. Compare with catalogueSha256 in src/data/server-wallet-cost-curves.json.",
	}, []string{"sha256", "as_of"})
	siteCurveMatches = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "server_wallet_cost_site_curve_matches",
		Help: "1 when the calculator curve on this site branch was built from the catalogue this harness prices from, 0 when not. Absent when the branch has no curve or the fetch failed.",
	}, []string{"branch"})
	prometheus.MustRegister(costMonthly, costPerTx, eligible, planConfidence,
		artifactOK, artifactDrift, artifactAge, lastRun, catalogueInfo, siteCurveMatches)
}
