package main

import (
	"math"
	"testing"
)

func fw(d24, d7, d30 float64) feeWindows {
	return feeWindows{Total24h: &d24, Total7d: &d7, Total30d: &d30}
}

func near(a, b float64) bool { return math.Abs(a-b) <= 1e-9*math.Max(1, math.Abs(b)) }

// A chain with $30M of fees over 30 days and a $3.65B token trades at
// P/F 10: 3.65e9 / (30e6 * 365 / 30) = 3.65e9 / 365e6.
func TestRatiosUseThirtyDayRunRate(t *testing.T) {
	o := computeChainFees(fw(1e6, 7e6, 30e6), fw(0.5e6, 3.5e6, 15e6), true, 3.65e9, true)
	if o.pf == nil || !near(*o.pf, 10) {
		t.Fatalf("pf = %v, want 10", deref(o.pf))
	}
	if o.ps == nil || !near(*o.ps, 20) {
		t.Fatalf("ps = %v, want 20", deref(o.ps))
	}
	if o.revShare == nil || !near(*o.revShare, 50) {
		t.Fatalf("revShare = %v, want 50", deref(o.revShare))
	}
	if o.fees24h == nil || *o.fees24h != 1e6 || o.rev7d == nil || *o.rev7d != 3.5e6 {
		t.Fatalf("windows not carried: %+v", o)
	}
}

// No fees over the month: nothing publishes. A $0 row that looks measured
// (Taiko, Mode on 2026-09-25) is worse than no row.
func TestNoFeesOverTheMonthPublishesNothing(t *testing.T) {
	o := computeChainFees(fw(0, 0, 0), fw(0, 0, 0), true, 1e9, true)
	if o.fees30d != nil || o.fees24h != nil || o.rev30d != nil || o.pf != nil || o.ps != nil || o.revShare != nil {
		t.Fatalf("expected an empty publish, got %+v", o)
	}
}

// A quiet day inside an active month is a real zero and publishes as one.
func TestQuietDayInsideActiveMonthPublishesZero(t *testing.T) {
	o := computeChainFees(fw(0, 2e6, 9e6), fw(0, 1e6, 4e6), true, 0, false)
	if o.fees24h == nil || *o.fees24h != 0 {
		t.Fatalf("fees24h = %v, want 0", deref(o.fees24h))
	}
	if o.pf != nil || o.ps != nil {
		t.Fatalf("no market cap, no ratio: %+v", o)
	}
}

// Revenue that DefiLlama does not report leaves the revenue side and the
// ratios that need it unpublished, while fees still publish.
func TestMissingRevenueKeepsFeesOnly(t *testing.T) {
	o := computeChainFees(fw(1e6, 7e6, 30e6), feeWindows{}, false, 1e9, true)
	if o.fees30d == nil || o.rev30d != nil || o.revShare != nil || o.ps != nil {
		t.Fatalf("unexpected revenue side: %+v", o)
	}
	if o.pf == nil {
		t.Fatalf("P/F needs fees only and should publish")
	}
	zero := 0.0
	o = computeChainFees(fw(1e6, 7e6, 30e6), feeWindows{Total24h: &zero, Total7d: &zero, Total30d: &zero}, true, 1e9, true)
	if o.ps != nil {
		t.Fatalf("zero revenue is not a division: %+v", o)
	}
	if o.revShare == nil || *o.revShare != 0 {
		t.Fatalf("zero revenue over positive fees is a 0%% share: %+v", o)
	}
}

func deref(p *float64) float64 {
	if p == nil {
		return math.NaN()
	}
	return *p
}
