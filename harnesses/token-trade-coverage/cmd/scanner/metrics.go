package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metric surface. Labels are (provider, chain, token). Kept exactly
// three labels so PromQL aggregation stays simple and the spec's
// `series` query at the bench level can group by any one of them.
var (
	capturePct = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "ocb_token_trade_capture_pct",
		Help: "Percent of the union-baseline trade count returned by this provider for (chain, token) in the last measurement window.",
	}, []string{"provider", "chain", "token"})

	absoluteCount = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "ocb_token_trade_absolute_count",
		Help: "Raw trade count returned by this provider for (chain, token) in the last measurement window.",
	}, []string{"provider", "chain", "token"})

	queryLatency = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "ocb_token_trade_query_latency_ms",
		Help: "Wall-clock latency of the provider's trade fetch call including pagination, in milliseconds.",
	}, []string{"provider", "chain", "token"})

	dexCount = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "ocb_token_trade_dex_count",
		Help: "Distinct DEX venues represented in the trade set returned by this provider for (chain, token).",
	}, []string{"provider", "chain", "token"})

	probeOK = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "ocb_token_trade_probe_ok",
		Help: "1 on successful fetch, 0 on error or timeout. Consumed by the bench spec's `success` query.",
	}, []string{"provider", "chain", "token"})

	// Cumulative API-call counter for quota observability. Counted at
	// the fetchOne granularity — one increment per (provider, token)
	// tuple in a sweep, regardless of how many paginated sub-requests
	// fired underneath — because that's what maps 1:1 to the provider's
	// monthly point/credit budget as billed. `increase(...[30d])` per
	// provider gives the running monthly consumption.
	apiCalls = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "ocb_token_trade_api_calls_total",
		Help: "Total fetchOne invocations per provider since worker start. Query with increase()[30d] for monthly consumption vs free-tier budget.",
	}, []string{"provider"})
)

// Result is the per-call outcome of one provider fetch.
type Result struct {
	Provider  string
	Chain     string
	Token     string
	Count     int
	DexCount  int
	LatencyMs float64
	OK        bool
}

// emitCycle publishes one full cycle's worth of results. Called once
// per (chain, token) after every provider has been queried and the
// union baseline is known.
func emitCycle(results []Result, unionMax int) {
	for _, r := range results {
		lbl := prometheus.Labels{
			"provider": r.Provider,
			"chain":    r.Chain,
			"token":    r.Token,
		}
		absoluteCount.With(lbl).Set(float64(r.Count))
		queryLatency.With(lbl).Set(r.LatencyMs)
		dexCount.With(lbl).Set(float64(r.DexCount))
		if r.OK {
			probeOK.With(lbl).Set(1)
		} else {
			probeOK.With(lbl).Set(0)
		}
		if unionMax > 0 && r.OK {
			capturePct.With(lbl).Set(float64(r.Count) / float64(unionMax) * 100)
		} else {
			capturePct.With(lbl).Set(0)
		}
		apiCalls.WithLabelValues(r.Provider).Inc()
	}
}
