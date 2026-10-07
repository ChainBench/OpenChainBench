package main

import (
	"fmt"
	"math"
)

// How often each agent actually trades.
//
// The arena holds everything constant except the model: same harness, same
// prompt, same pair, same six days. Under those conditions the eight agents
// trade between 2 and 89 times a round, a spread of forty to one, and nothing
// anywhere publishes it.
//
// It matters twice over.
//
// First as a result in its own right. Two agents running the same model under
// the same instructions, separated only by whether they are fed numbers or an
// image, differ by more than an order of magnitude in how much they act. That
// is a measurement of behavioural variance, and it is the kind of thing a
// single-number leaderboard cannot show.
//
// Second because of what it does to the headline. At roughly 29 trades a round
// and Aerodrome's 0.05 % volatile-pool fee, full portfolio turnover on every
// trade would cost about 1.45 % a week against a measured shortfall of 1.07 %.
// Friction on that arithmetic is large enough to account for the entire gap.
//
// The cross-section refuses to go along with it: the correlation between
// trades per round and alpha is -0.25 (Spearman -0.41) over eight agents,
// which is nothing. gpt-5.2 chart trades 2.2 times a round and still gives up
// 16.4 points; grok 4 vision trades 88.7 times and finishes third.
//
// So friction is big enough to matter in aggregate and is not what separates
// the agents, and both halves are worth saying. What would settle it is the
// NOTIONAL of each trade, which this API does not serve (/trades answers 401)
// and which is on-chain: the upstream publishes each agent's wallet address,
// so every swap is independently checkable on Base. That is the next phase,
// and this file is what makes the case for it measurable rather than a guess.

// agentDetail is the /agents/{id} record. It carries the lifetime counters and
// the wallet; neither appears on the per-competition rows the scoring walk
// reads.
type agentDetail struct {
	Agent struct {
		Name          string `json:"name"`
		WalletAddress string `json:"walletAddress"`
		Stats         struct {
			TotalTrades           *float64 `json:"totalTrades"`
			CompletedCompetitions *float64 `json:"completedCompetitions"`
		} `json:"stats"`
	} `json:"agent"`
}

// activity is what we publish per agent.
type activity struct {
	totalTrades    float64
	tradesPerRound float64
	wallet         string
}

// fetchActivity reads one record per agent id.
//
// The counters are lifetime, not per arena, so they would be diluted by rounds
// an agent ran elsewhere. They are not: checked against
// /agents/{id}/competitions, 35 to 37 of every agent's 32 to 34 completed
// rounds are this arena. The caller still treats a missing counter as missing
// rather than zero, because a zero here would read as "never trades" and that
// is a very different claim from "we do not know".
func fetchActivity(ids map[string]string) map[string]activity {
	out := map[string]activity{}
	for name, id := range ids {
		var d agentDetail
		if err := getJSON(fmt.Sprintf("%s/agents/%s", recallAPI, id), &d); err != nil {
			errors.WithLabelValues("agent_detail").Inc()
			continue
		}
		st := d.Agent.Stats
		if st.TotalTrades == nil || st.CompletedCompetitions == nil ||
			*st.CompletedCompetitions <= 0 {
			continue
		}
		per := *st.TotalTrades / *st.CompletedCompetitions
		if math.IsNaN(per) || math.IsInf(per, 0) {
			continue
		}
		out[name] = activity{
			totalTrades:    *st.TotalTrades,
			tradesPerRound: per,
			wallet:         d.Agent.WalletAddress,
		}
	}
	return out
}
