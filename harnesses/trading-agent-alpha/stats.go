package main

import (
	"math"
	"sort"
)

// Significance for bench 284.
//
// The page ranks eight agents over a 19.6-point spread, and a reader will take
// that as a hierarchy. It is not one. Measured on the paired weekly
// differences, no two agents in this arena are separable: every t is under
// 1.3, and separating first from second at t=2 would need on the order of six
// hundred weeks against the twenty-three we have.
//
// The headline is in better shape but is not there yet either. The pooled
// shortfall is about one point a week with a t near -1.7, so it is
// directionally supported and not yet significant. It needs roughly thirty-one
// rounds, which is eight more than we hold.
//
// None of that is a reason to publish less. It is a reason to publish the
// uncertainty next to the number, which is what this file computes.

// roundObs is one scored round: the asset's move over the window, and what
// each funded agent returned in it. Keeping the round as a unit is the whole
// point: the agents trade the same week, so their errors are correlated and
// the agent-round is not an independent observation. The round is.
type roundObs struct {
	assetPct float64
	agents   map[string]float64
}

func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return math.NaN()
	}
	s := 0.0
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

// sd is the population standard deviation. Population rather than sample
// because these are every round that happened, not a draw from a larger set of
// rounds, and at n over 20 the distinction moves the figure by about 2%.
func sd(xs []float64) float64 {
	if len(xs) < 2 {
		return math.NaN()
	}
	m := mean(xs)
	s := 0.0
	for _, x := range xs {
		s += (x - m) * (x - m)
	}
	return math.Sqrt(s / float64(len(xs)))
}

// tStat is the mean over its own standard error. Returns NaN rather than an
// infinity when the series cannot support the test, so a caller that forgets
// to check publishes nothing instead of publishing a confident wrong number.
func tStat(xs []float64) float64 {
	if len(xs) < 3 {
		return math.NaN()
	}
	s := sd(xs)
	if s == 0 || math.IsNaN(s) {
		return math.NaN()
	}
	return mean(xs) / (s / math.Sqrt(float64(len(xs))))
}

// roundsForT2 is how many rounds this effect size would need to reach t=2,
// holding the observed mean and dispersion. It is the honest answer to "when
// will you know", and it is the number worth publishing next to a finding that
// is not yet significant.
func roundsForT2(xs []float64) float64 {
	m, s := mean(xs), sd(xs)
	if m == 0 || math.IsNaN(m) || math.IsNaN(s) {
		return math.NaN()
	}
	return (2 * s / math.Abs(m)) * (2 * s / math.Abs(m))
}

// pooledAlpha returns the round-level mean alpha residual series: for each
// round, the average across the eligible agents that funded it of what the
// agent returned minus what its own measured beta would have returned.
//
// Averaging within the round first is what makes these independent
// observations. Pooling every agent-round instead would treat eight views of
// one week as eight weeks and overstate the confidence by roughly the square
// root of the roster size.
func pooledAlpha(rounds []roundObs, betas map[string]float64) []float64 {
	out := make([]float64, 0, len(rounds))
	for _, r := range rounds {
		res := make([]float64, 0, len(r.agents))
		for name, pnl := range r.agents {
			b, ok := betas[name]
			if !ok {
				continue // not on the ranked roster
			}
			res = append(res, pnl-b*r.assetPct)
		}
		if len(res) > 0 {
			out = append(out, mean(res))
		}
	}
	return out
}

// agentAlphaSeries is one agent's per-round alpha residuals, for a t against
// zero on its own record.
func agentAlphaSeries(name string, rounds []roundObs, beta float64) []float64 {
	out := make([]float64, 0, len(rounds))
	for _, r := range rounds {
		if pnl, ok := r.agents[name]; ok {
			out = append(out, pnl-beta*r.assetPct)
		}
	}
	return out
}

// separablePairs counts how many of the pairwise comparisons between ranked
// agents survive their own noise at |t| > 2.
//
// Pairing on the weeks BOTH agents ran is what makes this the right test: the
// difference cancels the market entirely, with no beta to estimate and no
// counterfactual to argue about. If the answer is zero, the published order is
// an order of finish and the page has to say so.
func separablePairs(names []string, rounds []roundObs) (separable, tested int, maxAbsT float64) {
	sort.Strings(names)
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			var diffs []float64
			for _, r := range rounds {
				a, okA := r.agents[names[i]]
				b, okB := r.agents[names[j]]
				if okA && okB {
					diffs = append(diffs, a-b)
				}
			}
			if len(diffs) < 5 {
				continue // too few common weeks to say anything either way
			}
			tested++
			t := tStat(diffs)
			if math.IsNaN(t) {
				continue
			}
			if math.Abs(t) > maxAbsT {
				maxAbsT = math.Abs(t)
			}
			if math.Abs(t) > 2 {
				separable++
			}
		}
	}
	return separable, tested, maxAbsT
}

// capitalStats returns the median portfolio value across an agent's funded
// rounds and the ratio of its largest to its smallest.
//
// The ratio is the one that matters for reading the table. A value near 1 means
// the agent traded a stable base throughout; the two agents that fell to
// single-digit dollars carry ratios near 86, which means their late rounds and
// their early rounds are not the same experiment. Fixed per-swap gas is
// weightless on three hundred dollars and heavy on three.
func capitalStats(o []observation) (median, ratio float64, ok bool) {
	caps := make([]float64, 0, len(o))
	for _, x := range o {
		if x.capital > 0 {
			caps = append(caps, x.capital)
		}
	}
	if len(caps) == 0 {
		return 0, 0, false
	}
	sort.Float64s(caps)
	n := len(caps)
	if n%2 == 1 {
		median = caps[n/2]
	} else {
		median = (caps[n/2-1] + caps[n/2]) / 2
	}
	if caps[0] > 0 {
		ratio = caps[n-1] / caps[0]
	}
	return median, ratio, true
}
