package main

import (
	"math"
	"testing"
)

// The statistics are the claim now, so they get tested against hand-computable
// cases rather than against themselves.

func TestSdAndT(t *testing.T) {
	// Population sd of 2,4,4,4,5,5,7,9 is exactly 2, mean exactly 5.
	xs := []float64{2, 4, 4, 4, 5, 5, 7, 9}
	if got := mean(xs); math.Abs(got-5) > 1e-12 {
		t.Errorf("mean = %v, want 5", got)
	}
	if got := sd(xs); math.Abs(got-2) > 1e-12 {
		t.Errorf("sd = %v, want 2", got)
	}
	// t = 5 / (2/sqrt(8)) = 5*sqrt(8)/2 = 7.0710678...
	if got := tStat(xs); math.Abs(got-7.0710678118654755) > 1e-9 {
		t.Errorf("tStat = %v, want 7.07106781", got)
	}
}

func TestDegenerateSeriesReturnNaN(t *testing.T) {
	// A caller that forgets to check must publish nothing, never a confident
	// wrong number. That is why these are NaN and not zero or infinity.
	for _, xs := range [][]float64{nil, {}, {1}, {1, 2}} {
		if !math.IsNaN(tStat(xs)) {
			t.Errorf("tStat(%v) should be NaN", xs)
		}
	}
	flat := []float64{3, 3, 3, 3}
	if !math.IsNaN(tStat(flat)) {
		t.Errorf("tStat of a zero-variance series should be NaN, got %v", tStat(flat))
	}
	if !math.IsNaN(roundsForT2([]float64{0, 0, 0, 0})) {
		t.Error("roundsForT2 with a zero mean should be NaN, not an infinity")
	}
}

func TestRoundsForT2(t *testing.T) {
	// mean 1, population sd 2 -> (2*2/1)^2 = 16 rounds.
	xs := []float64{-1, 3, -1, 3}
	if m := mean(xs); math.Abs(m-1) > 1e-12 {
		t.Fatalf("fixture mean = %v, want 1", m)
	}
	if s := sd(xs); math.Abs(s-2) > 1e-12 {
		t.Fatalf("fixture sd = %v, want 2", s)
	}
	if got := roundsForT2(xs); math.Abs(got-16) > 1e-9 {
		t.Errorf("roundsForT2 = %v, want 16", got)
	}
}

// The pooled series must average WITHIN the round before testing. Pooling
// every agent-round instead treats eight views of one week as eight weeks and
// overstates confidence by about sqrt(roster).
func TestPooledAlphaAveragesWithinTheRound(t *testing.T) {
	betas := map[string]float64{"a": 1.0, "b": 0.0}
	rounds := []roundObs{
		{assetPct: 10, agents: map[string]float64{"a": 12, "b": 4}},
		{assetPct: -10, agents: map[string]float64{"a": -8, "b": -2}},
	}
	// Round 1: a -> 12-10 = 2, b -> 4-0 = 4, mean 3.
	// Round 2: a -> -8+10 = 2, b -> -2-0 = -2, mean 0.
	got := pooledAlpha(rounds, betas)
	want := []float64{3, 0}
	if len(got) != len(want) {
		t.Fatalf("got %d rounds, want %d", len(got), len(want))
	}
	for i := range want {
		if math.Abs(got[i]-want[i]) > 1e-12 {
			t.Errorf("round %d: got %v, want %v", i, got[i], want[i])
		}
	}
}

func TestPooledAlphaSkipsUnrankedAgents(t *testing.T) {
	// An agent with no beta is off the ranked roster and must not contribute,
	// or the minority entries with two or three rounds each leak back in.
	betas := map[string]float64{"a": 1.0}
	rounds := []roundObs{{assetPct: 10, agents: map[string]float64{"a": 12, "stray": 999}}}
	got := pooledAlpha(rounds, betas)
	if len(got) != 1 || math.Abs(got[0]-2) > 1e-12 {
		t.Errorf("got %v, want [2]", got)
	}
}

func TestSeparablePairs(t *testing.T) {
	// b beats a by exactly 5 every week: zero variance in the difference, so
	// tStat is NaN and the pair cannot be declared separable. Degenerate on
	// purpose; the real data never looks like this.
	rounds := make([]roundObs, 8)
	for i := range rounds {
		rounds[i] = roundObs{assetPct: 0, agents: map[string]float64{
			"a": float64(i), "b": float64(i) + 5,
		}}
	}
	sep, tested, _ := separablePairs([]string{"a", "b"}, rounds)
	if tested != 1 {
		t.Errorf("tested = %d, want 1", tested)
	}
	if sep != 0 {
		t.Errorf("a zero-variance difference must not count as separable, got %d", sep)
	}

	// Fewer than five common weeks is not tested at all, in either direction.
	short := []roundObs{
		{agents: map[string]float64{"a": 1, "b": 2}},
		{agents: map[string]float64{"a": 1, "b": 2}},
	}
	_, tested2, _ := separablePairs([]string{"a", "b"}, short)
	if tested2 != 0 {
		t.Errorf("tested = %d on 2 common weeks, want 0", tested2)
	}
}

func TestAgentAlphaSeriesUsesOnlyItsOwnRounds(t *testing.T) {
	rounds := []roundObs{
		{assetPct: 10, agents: map[string]float64{"a": 12}},
		{assetPct: 10, agents: map[string]float64{"b": 12}}, // a sat this one out
		{assetPct: -5, agents: map[string]float64{"a": -4}},
	}
	got := agentAlphaSeries("a", rounds, 1.0)
	want := []float64{2, 1}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if math.Abs(got[i]-want[i]) > 1e-12 {
			t.Errorf("i=%d got %v want %v", i, got[i], want[i])
		}
	}
}
