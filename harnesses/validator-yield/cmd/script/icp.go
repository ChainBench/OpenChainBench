package main

import (
	"context"
	"fmt"
	"net/http"
)

// Internet Computer (ICP). Source: the ICP dashboard public API
// (ic-api.internetcomputer.org/api/v3/governance-metrics, no key),
// which republishes the NNS governance canister's own metrics.
//
// ICP has no delegated validator staking: node providers are paid
// separately. What an ICP holder stakes into is an NNS neuron, which
// earns voting rewards (as maturity) for voting on proposals,
// directly or by following. Reward rule: every day the NNS
// distributes a reward pool (latest_reward_event_total_available_e8s)
// across the deciding voting power of eligible neurons:
//
//	neuron_reward/day = pool × neuron_voting_power / total_deciding_voting_power
//	voting_power      = stake × dissolve_delay_bonus × age_bonus (× 1.1 8-year gang)
//
// so a neuron's APR depends on its profile. The bench publishes ONE
// fixed profile: a new neuron at the maximum dissolve delay (2 years
// since Mission 70), no age bonus, no 8-year gang flag, voting on
// every proposal. Its multiplier is the maximum dissolve-delay bonus
// icpMaxDissolveBonus = 3 (Mission 70 curve 1 + 2·(d/2y)²; verified
// on-chain: DFINITY neuron 27 at 2y, max age, gang flag has deciding
// voting power 4.125 × stake = 3 × 1.25 × 1.1). So
//
//	apr = 365.25 × pool_per_day × 3 / total_deciding_voting_power
//
// A shorter dissolve delay earns less (2 weeks: bonus ~1.0, a third of
// this), and maturity is paid in maturity, not ICP: disbursing it is
// subject to the NNS maturity modulation (about ±5%). Verified
// 2026-11-03: pool 53 166 ICP/day, deciding voting power 583.1M →
// 9.99% APR.

const (
	icpChain            = "icp"
	icpTag              = "ic_api_governance"
	icpMaxDissolveBonus = 3.0
	e8s                 = 1e8
)

var icpMetricsURL = envDefault("VAL_ECON_ICP_METRICS_URL", "https://ic-api.internetcomputer.org/api/v3/governance-metrics")

type icpMetrics struct {
	Metrics []struct {
		Name    string `json:"name"`
		Subsets []struct {
			Value []any `json:"value"` // [timestamp, "value"]
		} `json:"subsets"`
	} `json:"metrics"`
}

func (m icpMetrics) scalar(name string) float64 {
	for _, x := range m.Metrics {
		if x.Name == name && len(x.Subsets) == 1 && len(x.Subsets[0].Value) == 2 {
			if s, ok := x.Subsets[0].Value[1].(string); ok {
				return parseFloat(s)
			}
		}
	}
	return 0
}

// icpNeuronAPR for a neuron with voting-power multiplier `mult`.
// rounds > 1 means the pool rolled over undistributed days, so the
// per-day pool is pool / rounds.
func icpNeuronAPR(poolE8s, rounds, decidingVPE8s, mult float64) float64 {
	if rounds < 1 {
		rounds = 1
	}
	if decidingVPE8s <= 0 {
		return 0
	}
	return 365.25 * (poolE8s / rounds) * mult / decidingVPE8s
}

func scrapeICP(ctx context.Context, client *http.Client) {
	fail := func(err error) {
		scrapeErrorsTotal.WithLabelValues(icpChain, icpTag).Inc()
		fmt.Printf("[icp] governance metrics err: %v\n", err)
	}
	var m icpMetrics
	if err := getJSON(ctx, client, icpMetricsURL, &m); err != nil {
		fail(err)
		return
	}
	pool := m.scalar("governance_latest_reward_event_total_available_e8s")
	rounds := m.scalar("governance_latest_reward_event_rounds_since_last_distribution")
	deciding := m.scalar("governance_total_deciding_voting_power")
	staked := m.scalar("governance_total_staked_e8s")
	apr := icpNeuronAPR(pool, rounds, deciding, icpMaxDissolveBonus)
	if apr <= 0 || apr > 0.5 {
		fail(fmt.Errorf("implausible APR %.4f (pool %.0f, deciding VP %.0f)", apr, pool/e8s, deciding/e8s))
		return
	}
	bps := pctToBps(apr)
	row := valRow{
		ID: "nns-neuron-2y", Name: "NNS neuron, 2y dissolve delay, no age bonus",
		GrossBps: bps, NetBps: bps, CommissionBps: 0, UptimePct: 100,
		StakeNative: staked / e8s,
	}
	publishRows(icpChain, []valRow{row}, priceUSD(ctx, client, icpChain, "internet-computer"))
	fmt.Printf("[icp] published 2y-neuron APR %.0f bps (pool %.0f ICP/day over %.0f round(s), deciding VP %.1fM)\n",
		bps, pool/e8s, rounds, deciding/e8s/1e6)
}
