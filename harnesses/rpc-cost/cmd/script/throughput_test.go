package main

import "testing"

// Throughput is a second meter that binds before the bill does for
// several providers. A plan the reader could afford but cannot buy is a
// different answer from an expensive one.
func TestThroughputCeilingMakesPlanIneligible(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	pr := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1}}
	p := Provider{
		Slug: "tatum", Cohort: "usage", Currency: "USD", Unit: "credit",
		Weights: map[string]Weights{"ethereum": {Default: f(2)}},
	}
	// Tatum publishes 200 rps on every tier.
	pl := Plan{
		ID: "scale", MonthlyUSD: f(999), IncludedUnits: f(400e6), AllowancePeriod: "month",
		OveragePer1M: f(9), OverageAllowed: "true", Archive: "true", Confidence: "verified",
		Throughput: Throughput{Unit: "rps", Value: f(200)},
	}
	// 100M requests/month = 38.6 rps sustained — inside 200.
	if q := quote(c, p, pl, pr, 100e6); !q.Eligible {
		t.Errorf("38.6 rps should fit a 200 rps cap, got %q", q.Reason)
	}
	// 1,000M requests/month = 385.8 rps — over it.
	q := quote(c, p, pl, pr, 1000e6)
	if q.Eligible {
		t.Error("386 rps sustained must not fit a published 200 rps cap")
	}
	if q.Reason == "" {
		t.Error("throughput rejection must carry a reason naming both numbers")
	}
}

// Alchemy's ceiling is in compute units per second, not requests, so the
// weighted units matter: the same request count fails on a heavy method
// mix and passes on a light one.
func TestThroughputInUnitsPerSecondUsesWeightedUnits(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	p := Provider{
		Slug: "alchemy", Cohort: "usage", Currency: "USD", Unit: "cu",
		Weights: map[string]Weights{"ethereum": {
			Default: f(10), Methods: map[string]*float64{"eth_getBalance": f(10), "debug_traceTransaction": f(500)},
		}},
	}
	pl := Plan{
		ID: "payg", MonthlyUSD: f(0), IncludedUnits: f(0), AllowancePeriod: "month",
		OveragePer1M: f(0.525), OverageAllowed: "true", Archive: "true", Confidence: "verified",
		Throughput: Throughput{Unit: "cu_per_s", Value: f(30000)},
	}
	light := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1}}
	heavy := Profile{ID: "trace", Chain: "ethereum", Mix: map[string]float64{"debug_traceTransaction": 1}}

	// 1,000M light requests = 385.8 req/s x 10 CU = 3,858 CU/s, fine.
	if q := quote(c, p, pl, light, 1000e6); !q.Eligible {
		t.Errorf("light mix should fit 30,000 CU/s, got %q", q.Reason)
	}
	// Same volume of trace calls = 385.8 x 500 = 192,901 CU/s, 6x over.
	q := quote(c, p, pl, heavy, 1000e6)
	if q.Eligible {
		t.Error("trace mix at 1,000M/mo must exceed a 30,000 CU/s ceiling")
	}
}

// A plan that publishes no throughput figure must not be rejected for it.
// Half the cohort leaves the number unstated and absence is not a zero.
func TestUnpublishedThroughputDoesNotBlock(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	pr := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1}}
	p := Provider{
		Slug: "nownodes", Cohort: "usage", Currency: "USD", Unit: "request",
		Weights: map[string]Weights{"ethereum": {Default: f(1)}},
	}
	pl := Plan{
		ID: "enterprise", MonthlyUSD: f(500), IncludedUnits: f(1000e6), AllowancePeriod: "month",
		OveragePer1M: f(5), OverageAllowed: "true", Archive: "true", Confidence: "verified",
		Throughput: Throughput{Unit: "rps", Value: nil},
	}
	if q := quote(c, p, pl, pr, 1000e6); !q.Eligible {
		t.Errorf("unpublished throughput must not block a plan, got %q", q.Reason)
	}
}
