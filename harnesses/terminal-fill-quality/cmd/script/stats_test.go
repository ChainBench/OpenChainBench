package main

import (
	"math"
	"testing"
)

// Equal weights reproduce the plain median on an odd sample; a pooled
// entry's weights move the median towards the heavier row.
func TestWeightedMedian(t *testing.T) {
	v := []float64{100, 200, 300, 400, 500}
	w := []float64{1, 1, 1, 1, 1}
	if got := wpct(v, w, 0.5); got != median(v) {
		t.Fatalf("equal weights: got %v, want %v", got, median(v))
	}
	// Two rows: a Solana row at 340 bps sampled 100 times for 300,000
	// attempts, an Arc row at 200 bps sampled 280 times for 11,000.
	var vals, ws []float64
	for i := 0; i < 100; i++ {
		vals, ws = append(vals, 340), append(ws, 300000.0/100)
	}
	for i := 0; i < 280; i++ {
		vals, ws = append(vals, 200), append(ws, 11000.0/280)
	}
	if plain := median(vals); plain != 200 {
		t.Fatalf("plain median of the concatenation: got %v, want 200 (the sampler's view)", plain)
	}
	if got := wpct(vals, ws, 0.5); got != 340 {
		t.Fatalf("weighted median: got %v, want 340 (the users' view)", got)
	}
	q := wquantiles(vals, ws, true, true)
	if q == nil || q.Median != 340 || q.P99 != 340 || q.CILo == nil || *q.CILo > 340 || *q.CIHi < 340 {
		t.Fatalf("wquantiles: %+v", q)
	}
	if q2 := wquantiles(v, w, false, false); q2.Median != 300 || q2.P90 != pct([]float64{100, 200, 300, 400, 500}, 0.9) || q2.P99 == 0 {
		t.Fatalf("plain quantiles through wquantiles: %+v", q2)
	}
	if got := wpct(v, []float64{0, 0, 0, 0, 0}, 0.5); got != median(v) {
		t.Fatalf("zero weights fall back to the plain median: got %v", got)
	}
	if got := wpct(nil, nil, 0.5); got != 0 || math.IsNaN(got) {
		t.Fatalf("empty input: got %v", got)
	}
}

// Execution quality is loss minus the app's fee ON EACH SWAP, then the
// median — not the median loss minus the median fee. The two agree only
// when the fee is the same on every swap, which is what an app running
// promos, rebates or tiered fees breaks. Measured live, the naive form
// is off by 33 bps on FOMO, the row the subtraction moves furthest.
func TestExecutionQualitySubtractsPerSwap(t *testing.T) {
	// Three unequal groups, so the two forms cannot coincide: the middle
	// group pays a fee, the cheap and the expensive ones do not, and the
	// fee's own median (0) describes none of the swaps that pay it.
	var loss, fee []float64
	for i := 0; i < 7; i++ {
		loss = append(loss, 200)
		fee = append(fee, 0)
	}
	for i := 0; i < 7; i++ {
		loss = append(loss, 400)
		fee = append(fee, 350)
	}
	for i := 0; i < 7; i++ {
		loss = append(loss, 1000)
		fee = append(fee, 0)
	}
	var ex, w []float64
	for i := range loss {
		ex = append(ex, loss[i]-fee[i])
		w = append(w, 1)
	}

	got := wquantiles(ex, w, false, false)
	if got == nil {
		t.Fatal("no quantiles for the ex-fee series")
	}
	naive := wquantiles(loss, w, false, false).Median - wquantiles(fee, w, false, false).Median

	if math.Abs(got.Median-200) > 1 {
		t.Fatalf("per-swap median should be 200, got %.0f", got.Median)
	}
	if math.Abs(naive-400) > 1 {
		t.Fatalf("the naive form should be 400 here, got %.0f — the cohort no longer separates the two", naive)
	}
	if math.Abs(got.Median-naive) < 100 {
		t.Fatalf("the two forms landed together (%.0f vs %.0f): the test proves nothing", got.Median, naive)
	}
}
