package main

import "testing"

func TestSetFunding(t *testing.T) {
	tests := []struct {
		raw  string
		want float64
		ok   bool
	}{
		{raw: "0.0001", want: 1, ok: true},
		{raw: "-0.0002", want: -2, ok: true},
		{raw: "", ok: false},
		{raw: "NaN", ok: false},
		{raw: "+Inf", ok: false},
	}
	for _, tc := range tests {
		t.Run(tc.raw, func(t *testing.T) {
			var s PerpSample
			s.setFunding(tc.raw, bpsPerUnit)
			if s.HasFunding != tc.ok || !near(s.FundingRatePerHrBps, tc.want) {
				t.Errorf("got %v %v, want %v %v",
					s.FundingRatePerHrBps, s.HasFunding, tc.want, tc.ok)
			}
		})
	}
}
