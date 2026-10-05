package main

import (
	"math"
	"strings"
	"testing"
)

// The two blockers the 2026-09-30 audit found and that survived until
// 2026-10-05. Both produced a plausible wrong number, which is why eighteen
// existing tests passed over them, and both moved a published winner.
//
// The audit asked for these as R5 and R7.

// R5. Chainstack's archive surcharge is triggered by block age, not by method
// name, and several methods already carry the doubled figure in their own
// weight. Multiplying the weighted total again charged trace 3.6 RU against a
// real 2.0, an 80% overstatement.
func TestBlockAgeRaisesTheFloorItDoesNotScaleTheBill(t *testing.T) {
	// Chainstack's real Ethereum weights: everything 1 RU, debug and trace 2.
	p := Provider{
		Slug:     "chainstack",
		Currency: "USD",
		Unit:     "ru",
		Weights: map[string]Weights{
			"ethereum": {
				Default: f(1),
				Methods: map[string]*float64{
					"eth_getLogs":            f(1),
					"eth_getBlockByNumber":   f(1),
					"eth_getBlockReceipts":   f(1),
					"debug_traceTransaction": f(2),
					"trace_block":            f(2),
				},
			},
		},
		ArchiveRule: ArchiveRule{Kind: "block_age", Value: 2},
	}

	trace := Profile{
		ID: "trace", Chain: "ethereum", Archive: true,
		Mix: map[string]float64{
			"debug_traceTransaction": 0.60,
			"trace_block":            0.20,
			"eth_getBlockByNumber":   0.20,
		},
	}
	got, err := unitsPerRequest(p, trace)
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	// Floor is default x 2 = 2. The two already-2 methods are unaffected by
	// it; only getBlockByNumber is lifted, 1 -> 2. So a flat 2.0.
	//
	// The bug computed 0.6*2 + 0.2*2 + 0.2*1 = 1.8 and then doubled it to 3.6.
	if math.Abs(got-2.0) > 1e-9 {
		t.Errorf("trace units = %v, want 2.0 (3.6 is the double-count)", got)
	}

	// The indexer profile must NOT move: every method in it is 1 RU, so the
	// surcharge lifts all of them to 2 and the old multiplier reached the same
	// answer. A fix that changed this number would be over-reaching.
	indexer := Profile{
		ID: "indexer", Chain: "ethereum", Archive: true,
		Mix: map[string]float64{
			"eth_getLogs":          0.50,
			"eth_getBlockByNumber": 0.25,
			"eth_getBlockReceipts": 0.25,
		},
	}
	got, err = unitsPerRequest(p, indexer)
	if err != nil {
		t.Fatalf("indexer: %v", err)
	}
	if math.Abs(got-2.0) > 1e-9 {
		t.Errorf("indexer units = %v, want 2.0 unchanged", got)
	}

	// And at tip the surcharge does not apply at all, so the listed weights
	// stand: 0.6*2 + 0.2*2 + 0.2*1.
	tip := trace
	tip.Archive = false
	got, err = unitsPerRequest(p, tip)
	if err != nil {
		t.Fatalf("tip: %v", err)
	}
	if math.Abs(got-1.8) > 1e-9 {
		t.Errorf("non-archive trace units = %v, want 1.8", got)
	}
}

// A block_age rule with no chain default has nothing to act on. Inventing one
// would manufacture the number this bench exists to report, so it must refuse.
func TestBlockAgeWithoutADefaultRefusesToPrice(t *testing.T) {
	p := Provider{
		Slug: "hypothetical", Currency: "USD", Unit: "ru",
		Weights: map[string]Weights{
			"ethereum": {Methods: map[string]*float64{"eth_getLogs": f(1)}},
		},
		ArchiveRule: ArchiveRule{Kind: "block_age", Value: 2},
	}
	pr := Profile{Chain: "ethereum", Archive: true,
		Mix: map[string]float64{"eth_getLogs": 1.0}}
	if _, err := unitsPerRequest(p, pr); err == nil {
		t.Error("priced a block_age rule with no default weight; it must refuse")
	}
}

// R7. The dedicated cohort used to take needed = 0 for every plan, so the
// overage and max_units branches were unreachable. AWS AMB is dedicated
// capacity that ALSO bills per request, and it read $97.82 at every volume.
func TestDedicatedPlanThatMetersRequestsBillsThem(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	// AWS Managed Blockchain, us-east: a bc.t3.large node plus $3.00/1M
	// requests, with nothing included.
	p := Provider{Slug: "aws-amb", Currency: "USD", Unit: "request", Cohort: "dedicated"}
	pl := Plan{
		ID: "bc-t3-large-us-east", Tier: "business",
		MonthlyUSD:     f(97.82),
		IncludedUnits:  nil,
		OveragePer1M:   f(3.00),
		OverageAllowed: "true",
		Chains:         []string{"ethereum"},
	}
	pr := Profile{Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1.0}}

	q := quote(c, p, pl, pr, 1e9)
	if !q.Eligible {
		t.Fatalf("not eligible: %s", q.Reason)
	}
	// 1B requests at $3.00/1M is $3,000, on top of the node's $97.82.
	if math.Abs(q.MonthlyUSD-3097.82) > 1e-6 {
		t.Errorf("1B bill = %v, want 3097.82 (97.82 is the unmetered bug)", q.MonthlyUSD)
	}
	// And it must scale: the old behaviour was flat at every volume, which is
	// what made it lead every Dedicated cell.
	q10 := quote(c, p, pl, pr, 10e6)
	if math.Abs(q10.MonthlyUSD-127.82) > 1e-6 {
		t.Errorf("10M bill = %v, want 127.82", q10.MonthlyUSD)
	}
	if q10.MonthlyUSD >= q.MonthlyUSD {
		t.Error("a metered plan must cost more at a higher volume")
	}
}

// The other 33 of 37 dedicated plans are genuinely flat: a monthly fee for
// unlimited requests. `included_units: null` means the opposite thing for
// them, and that ambiguity is what produced the blocker. They must not become
// ineligible for "allowance exceeded and no published overage rate".
func TestFlatDedicatedPlanStaysFlat(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	p := Provider{Slug: "getblock-dedicated", Currency: "USD", Unit: "request", Cohort: "dedicated"}
	pl := Plan{
		ID: "dedicated-eth-full", Tier: "business",
		MonthlyUSD: f(880),
		Chains:     []string{"ethereum"},
	}
	pr := Profile{Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1.0}}

	for _, requests := range []float64{10e6, 100e6, 1e9} {
		q := quote(c, p, pl, pr, requests)
		if !q.Eligible {
			t.Fatalf("%.0f requests: not eligible: %s", requests, q.Reason)
		}
		if math.Abs(q.MonthlyUSD-880) > 1e-9 {
			t.Errorf("%.0f requests: bill = %v, want a flat 880", requests, q.MonthlyUSD)
		}
	}
}

// Zeeve publishes request ceilings with no overage rate. Past the ceiling the
// plan is unavailable, not free, and the old needed = 0 never reached this.
func TestDedicatedCeilingBindsAboveIt(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	p := Provider{Slug: "zeeve", Currency: "USD", Unit: "request", Cohort: "dedicated"}
	pl := Plan{
		ID: "eth-basic", Tier: "growth",
		MonthlyUSD:    f(112),
		IncludedUnits: f(250e6),
		MaxUnits:      f(250e6),
		Chains:        []string{"ethereum"},
	}
	pr := Profile{Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1.0}}

	// Inside the ceiling: the flat fee.
	if q := quote(c, p, pl, pr, 100e6); !q.Eligible || math.Abs(q.MonthlyUSD-112) > 1e-9 {
		t.Errorf("100M: eligible=%v bill=%v, want eligible at 112", q.Eligible, q.MonthlyUSD)
	}
	// Above it: unavailable, with the ceiling named.
	q := quote(c, p, pl, pr, 1e9)
	if q.Eligible {
		t.Errorf("1B: priced at %v, but the plan's ceiling is 250M", q.MonthlyUSD)
	}
	if q.Reason == "" {
		t.Error("ineligible with no reason; the page renders the reason")
	}
}

// R6. An unstated capability is not a granted one.
//
// `archive: null` and `trace: null` passed both gates, because one tested for
// the string "false" and the other for a non-nil pointer. 27 of the 106 usage
// plans are null on each field, and NOWNodes won trace cells on a capability
// it makes no claim about.
func TestUnstatedCapabilityIsNotRanked(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	p := Provider{
		Slug: "nownodes", Currency: "USD", Unit: "request", Cohort: "usage",
		Weights: map[string]Weights{"ethereum": {Default: f(1)}},
	}
	traceProfile := Profile{
		Chain: "ethereum", Archive: true,
		Mix: map[string]float64{"debug_traceTransaction": 1.0},
	}
	archiveProfile := Profile{
		Chain: "ethereum", Archive: true,
		Mix: map[string]float64{"eth_getLogs": 1.0},
	}

	// Null on both: not ranked on either workload, and the reason must say the
	// support is unpublished rather than absent, which is a claim we cannot
	// make on the provider's behalf.
	silent := Plan{ID: "enterprise", Tier: "enterprise", MonthlyUSD: f(200),
		IncludedUnits: f(1e12), Archive: "", Trace: nil}
	for name, pr := range map[string]Profile{"trace": traceProfile, "archive": archiveProfile} {
		q := quote(c, p, silent, pr, 10e6)
		if q.Eligible {
			t.Errorf("%s: ranked at $%v on an unpublished capability", name, q.MonthlyUSD)
		}
		if !strings.Contains(q.Reason, "not published") {
			t.Errorf("%s: reason %q should say the support is unpublished, not that "+
				"the plan lacks it", name, q.Reason)
		}
	}

	// An explicit claim still ranks, or the gate would empty the cells.
	yes := Plan{ID: "pro", Tier: "growth", MonthlyUSD: f(90),
		IncludedUnits: f(1e12), Archive: "true", Trace: boolp(true)}
	if q := quote(c, p, yes, traceProfile, 10e6); !q.Eligible {
		t.Errorf("explicit trace: true was not ranked: %s", q.Reason)
	}

	// And an explicit denial keeps its own, different, reason.
	no := Plan{ID: "start", Tier: "entry", MonthlyUSD: f(0),
		IncludedUnits: f(1e12), Archive: "false", Trace: boolp(false)}
	q := quote(c, p, no, archiveProfile, 10e6)
	if q.Eligible {
		t.Error("archive: false was ranked on an archive workload")
	}
	if strings.Contains(q.Reason, "not published") {
		t.Errorf("reason %q: the provider DID state this, so it must not read as "+
			"a gap in our catalogue", q.Reason)
	}
}

func boolp(v bool) *bool { return &v }
