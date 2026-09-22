package main

import (
	"math"
	"testing"
)

// The invariant that caught the bug: a pooled row's component is a weighted
// combination of its trade-size buckets, so the pooled value must lie
// between the smallest and the largest bucket value. The first cut gave
// FOMO 50 bps in all three buckets against 128 on the pooled row, because
// the buckets used a plain median over their swaps while the pooled row
// used the mean of the rows' medians weighted by the rows' attempts.

// product builds a two-chain product: one expensive row and one cheap one,
// each with swaps in two size buckets, so the estimators can disagree.
func product() (*State, map[string]bool, []string, map[string]float64) {
	st := &State{}
	add := func(term string, usd, termBps float64, n int) {
		for i := 0; i < n; i++ {
			loss := termBps + 10
			st.Swaps = append(st.Swaps, Swap{
				Terminal: term, Method: methodVersion, TradeUSD: usd,
				TerminalBps: termBps, NetworkBps: 1, LossBps: &loss, Priced: true,
			})
		}
	}
	// Expensive chain: few swaps, most of them small.
	add("x-solana", 10, 200, 30)
	add("x-solana", 500, 200, 5)
	// Cheap chain: many swaps, spread over both buckets.
	add("x-base", 10, 50, 40)
	add("x-base", 500, 50, 40)
	member := map[string]bool{"x-solana": true, "x-base": true}
	slugs := []string{"x-solana", "x-base"}
	// Attempts weight: the expensive chain carries as much flow as the cheap
	// one, which is exactly what makes a plain median over swaps disagree.
	att := map[string]float64{"x-solana": 100, "x-base": 100}
	return st, member, slugs, att
}

func TestBucketsDecomposeThePooledRow(t *testing.T) {
	st, member, slugs, att := product()
	all := chainMeanOfMedians(st, member, slugs, att, c2field, nil)
	got := map[string]float64{}
	for _, b := range []string{"under25", "over250"} {
		bucket := b
		cm := chainMeanOfMedians(st, member, slugs, att, c2field, func(s Swap) bool {
			return s.TradeUSD > 0 && sizeBucket(s.TradeUSD) == bucket
		})
		v, ok := cm["terminal"]
		if !ok {
			t.Fatalf("bucket %s published no terminal component", b)
		}
		got[b] = v
	}
	lo, hi := math.Min(got["under25"], got["over250"]), math.Max(got["under25"], got["over250"])
	if all["terminal"] < lo-0.001 || all["terminal"] > hi+0.001 {
		t.Fatalf("pooled terminal %.1f outside its buckets [%.1f, %.1f]: the buckets do not decompose the published figure",
			all["terminal"], lo, hi)
	}
}

func TestBucketWeightFollowsTheFlowInThatBucket(t *testing.T) {
	st, member, slugs, att := product()
	// Over $250 the expensive chain holds 5 swaps of its 35 and the cheap one
	// 40 of its 80, so the cheap chain must dominate that bucket: 100*5/35 =
	// 14.3 against 100*40/80 = 50, giving (14.3*200 + 50*50) / 64.3 = 83.4.
	cm := chainMeanOfMedians(st, member, slugs, att, c2field, func(s Swap) bool {
		return sizeBucket(s.TradeUSD) == "over250"
	})
	if math.Abs(cm["terminal"]-83.4) > 0.5 {
		t.Fatalf("over250 terminal = %.1f, want ~83.4 (weights scaled by each row's share of the bucket)", cm["terminal"])
	}
	// Under $25 the expensive chain holds 30 of 35 and the cheap one 40 of 80:
	// (85.7*200 + 50*50) / 135.7 = 144.7.
	cm = chainMeanOfMedians(st, member, slugs, att, c2field, func(s Swap) bool {
		return sizeBucket(s.TradeUSD) == "under25"
	})
	if math.Abs(cm["terminal"]-144.7) > 0.5 {
		t.Fatalf("under25 terminal = %.1f, want ~144.7", cm["terminal"])
	}
}

func TestUnfilteredKeepsTheExistingWeights(t *testing.T) {
	st, member, slugs, att := product()
	// nil keep must leave the pooled figure exactly as it was before the
	// filter existed: equal attempts, so the plain mean of the two medians.
	cm := chainMeanOfMedians(st, member, slugs, att, c2field, nil)
	if math.Abs(cm["terminal"]-125) > 0.001 {
		t.Fatalf("pooled terminal = %.3f, want 125 (unchanged by the new parameter)", cm["terminal"])
	}
}

func TestSizeSplitFloors(t *testing.T) {
	acc := map[string]*sizeAcc{
		"under25": {parsed: 5, loss: seq(5, 100), lossW: seq(5, 1), term: seq(5, 40), termW: seq(5, 1)},
		"25to250": {parsed: 30, loss: seq(30, 100), lossW: seq(30, 1), term: seq(30, 40), termW: seq(30, 1)},
		"over250": {parsed: 60, loss: seq(60, 100), lossW: seq(60, 1), term: seq(60, 40), termW: seq(60, 1)},
	}
	out := sizeSplit(acc, 20, 40, false)
	if _, ok := out["under25"]; ok {
		t.Fatal("a bucket under the publish floor must not publish at all")
	}
	if st, ok := out["25to250"]; !ok || st.Ranked {
		t.Fatal("between the floors the bucket publishes unranked")
	}
	if st, ok := out["over250"]; !ok || !st.Ranked {
		t.Fatal("above the rank floor the bucket is ranked")
	}
}

func seq(n int, v float64) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = v
	}
	return out
}

// The bug, kept as a test so the fix cannot be undone quietly: the first cut
// took a plain median over each bucket's swaps. On this product that gives 50
// bps in both buckets against a pooled 125, which is the FOMO shape observed
// on 2026-09-22 (50 / 49 / 47 against 128) and impossible to reconcile.
func TestPlainMedianPerBucketBreaksTheDecomposition(t *testing.T) {
	st, member, slugs, att := product()
	pooled := chainMeanOfMedians(st, member, slugs, att, c2field, nil)["terminal"]
	plain := map[string]float64{}
	for _, b := range []string{"under25", "over250"} {
		var vals []float64
		for _, s := range st.Swaps {
			if sizeBucket(s.TradeUSD) == b {
				vals = append(vals, s.TerminalBps)
			}
		}
		plain[b] = median(vals)
	}
	lo, hi := math.Min(plain["under25"], plain["over250"]), math.Max(plain["under25"], plain["over250"])
	if pooled >= lo-0.001 && pooled <= hi+0.001 {
		t.Fatalf("the old estimator no longer violates the invariant (pooled %.1f in [%.1f, %.1f]): this test has stopped describing the bug it guards",
			pooled, lo, hi)
	}
	t.Logf("old estimator: buckets %.0f and %.0f, pooled %.0f (outside, as it was in production)", plain["under25"], plain["over250"], pooled)
}
