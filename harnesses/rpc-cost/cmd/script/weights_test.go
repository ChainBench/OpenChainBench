package main

import (
	"math"
	"testing"

	"gopkg.in/yaml.v3"
)

// The Weights struct mixes a named `default` field with an inline map of
// per-method costs. If yaml.v3 routed `default` into the inline map, or
// dropped the methods, every unit cost in the bench would be silently
// wrong, so pin the behaviour rather than trusting it.
func TestWeightsInlineParse(t *testing.T) {
	var w Weights
	src := "default: 20\neth_call: 26\neth_getLogs: 60\n"
	if err := yaml.Unmarshal([]byte(src), &w); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if w.Default == nil || *w.Default != 20 {
		t.Errorf("default = %v, want 20", w.Default)
	}
	if got, ok := w.Weight("eth_call"); !ok || got != 26 {
		t.Errorf("eth_call = %v (%v), want 26 true", got, ok)
	}
	if got, ok := w.Weight("eth_getLogs"); !ok || got != 60 {
		t.Errorf("eth_getLogs = %v (%v), want 60 true", got, ok)
	}
	// An unlisted method must fall back to the default, which for dRPC
	// (flat 20 CU) and Infura (80 credits) is the entire published table.
	if got, ok := w.Weight("eth_chainId"); !ok || got != 20 {
		t.Errorf("fallback = %v (%v), want 20 true", got, ok)
	}
	if _, ok := w.Methods["default"]; ok {
		t.Error("`default` leaked into the inline method map")
	}
}

// A daily allowance is not a monthly pool. Infura's cap is per day and
// does not roll over, so a plan must be ineligible when the daily share
// of a monthly workload exceeds it, even though the monthly totals look
// like they fit.
func TestDailyCapIneligibleAboveDailyShare(t *testing.T) {
	included := 15e6
	cat := &Catalogue{FX: FX{EURUSD: 1}}
	p := Provider{
		Slug: "infura", Cohort: "usage", Unit: "credit", Currency: "USD",
		Weights: map[string]Weights{"ethereum": {Default: f(80)}},
	}
	price := 50.0
	pl := Plan{
		ID: "developer", MonthlyUSD: &price, IncludedUnits: &included,
		AllowancePeriod: "day", OverageAllowed: "hard_stop", Archive: "true",
	}
	pr := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1}}

	// 5M requests/month = 400M credits/month, but only 13.3M credits/day,
	// which fits inside 15M/day.
	if q := quote(cat, p, pl, pr, 5e6); !q.Eligible {
		t.Errorf("5M req/mo should fit a 15M credit/day cap, got %q", q.Reason)
	}
	// 10M requests/month = 26.7M credits/day, which does not.
	q := quote(cat, p, pl, pr, 10e6)
	if q.Eligible {
		t.Error("10M req/mo must not fit a 15M credit/day cap")
	}
	if q.Reason == "" {
		t.Error("ineligible quote must carry a reason for the page to render")
	}
}

// A hard-stop plan above its allowance is unavailable, not expensive.
// Ranking it at a computed overage price would invent a product.
func TestHardStopIsIneligibleNotPriced(t *testing.T) {
	included := 1e6
	price := 20.0
	cat := &Catalogue{FX: FX{EURUSD: 1}}
	p := Provider{
		Slug: "nownodes", Cohort: "usage", Unit: "request", Currency: "USD",
		Weights: map[string]Weights{"ethereum": {Default: f(1)}},
	}
	pl := Plan{
		ID: "pro", MonthlyUSD: &price, IncludedUnits: &included,
		AllowancePeriod: "month", OverageAllowed: "hard_stop", Archive: "true",
	}
	pr := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1}}

	if q := quote(cat, p, pl, pr, 2e6); q.Eligible || q.MonthlyUSD != 0 {
		t.Errorf("hard stop above allowance must be ineligible and unpriced, got %+v", q)
	}
}

// Packages that expire are not subscriptions. A 90-day package covering
// three months must have both its price and its allowance divided by
// three to sit honestly in a monthly table.
func TestPackagePeriodProRates(t *testing.T) {
	if got := periodScale("package_90d"); got != 30.0/90.0 {
		t.Errorf("package_90d scale = %v, want %v", got, 30.0/90.0)
	}
	if got := periodScale("month"); got != 1 {
		t.Errorf("month scale = %v, want 1", got)
	}
}

// EUR must not be compared against USD silently. NOWNodes is the only
// EUR provider in the cohort and the rate lives in the catalogue header.
func TestEURConvertsThroughCatalogueRate(t *testing.T) {
	cat := &Catalogue{FX: FX{EURUSD: 1.1}}
	if got := cat.toUSD(100, "EUR"); math.Abs(got-110) > 1e-9 {
		t.Errorf("EUR 100 = %v USD, want 110", got)
	}
	if got := cat.toUSD(100, "USD"); got != 100 {
		t.Errorf("USD must pass through unchanged, got %v", got)
	}
}

// A EUR-priced provider with no FX rate in the header must fail the
// catalogue load rather than quietly ranking euros as dollars.
func TestValidateRejectsEURWithoutRate(t *testing.T) {
	c := &Catalogue{Providers: []Provider{{
		Slug: "nownodes", Cohort: "usage", Currency: "EUR",
		Weights: map[string]Weights{"ethereum": {Default: f(1)}},
	}}}
	if err := c.validate(); err == nil {
		t.Error("EUR provider without fx.eur_usd must fail validation")
	}
}
