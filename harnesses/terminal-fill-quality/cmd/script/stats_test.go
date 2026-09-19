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
