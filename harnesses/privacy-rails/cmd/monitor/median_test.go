package main

import "testing"

// The two-value case is the reason this test exists.
//
// The pooled "All sizes" series was computed as c[len(c)/2], which is the
// larger of two values. The exit-cost probe publishes exactly two tiers, so
// a board's headline row was the $10k figure wearing a pooled label: it
// served 2,055 bps where the median of 223 and 2,055 is 1,139, on a tab
// labelled as the summary across sizes.
func TestMedianOfEvenCount(t *testing.T) {
	cases := []struct {
		name string
		in   []float64
		want float64
	}{
		// The exact pair the live board served wrong.
		{"the two exit-cost tiers", []float64{223.15, 2055.2}, 1139.175},
		{"two values, reversed input", []float64{2055.2, 223.15}, 1139.175},
		{"three values, the round trip", []float64{80.1, 40.98, 324.9}, 80.1},
		{"three, already sorted", []float64{40.98, 80.1, 324.9}, 80.1},
		{"four values", []float64{10, 20, 30, 40}, 25},
		{"one value", []float64{42}, 42},
		{"empty", []float64{}, 0},
	}
	for _, c := range cases {
		if got := medianOf(c.in); got != c.want {
			t.Errorf("%s: medianOf(%v) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
}

// The input must not be reordered: the caller still publishes the per-tier
// series from the same slice, and a sorted copy is the only safe way to do
// that.
func TestMedianOfDoesNotMutate(t *testing.T) {
	in := []float64{324.9, 40.98, 80.1}
	_ = medianOf(in)
	if in[0] != 324.9 || in[1] != 40.98 || in[2] != 80.1 {
		t.Errorf("medianOf reordered its input: %v", in)
	}
}
