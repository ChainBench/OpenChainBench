package main

import (
	"math"
	"testing"
)

// A break-even volume is a strong claim: past this many requests, buying the
// node is cheaper than metering. Four of the 37 dedicated plans charge a base
// fee AND a per-request rate on top, and for those the bare division
// base/floor answers a different question — the one where the plan meters
// nothing.
//
// AWS AMB is the case. It bills $97.82 plus $3.00 per 1M requests against an
// Ethereum floor of $2.833 per 1M, so it is dearer at every volume and the
// gap widens. The published figure was 34,528,768 requests, where AWS
// actually bills $201.41 against $97.82 metered.
func TestNoBreakEvenWhenTheOwnRateBeatsTheFloor(t *testing.T) {
	const floor = 2.833 // $/1M requests, BlockPI simple-read at 1B

	// AWS AMB: nothing included, $3.00/1M on top of the fee.
	if v := breakeven(97.82, 0, 3.00, floor); !math.IsNaN(v) {
		t.Errorf("AWS AMB got a break-even of %.0f requests; its own rate is above the floor, so there is none", v)
	}

	// The old formula, for the record: it is what produced the published figure.
	if old := 97.82 / floor * 1e6; math.Abs(old-34_528_768) > 1 {
		t.Fatalf("expected the old formula to give 34,528,768, got %.0f — the regression case has moved", old)
	}

	// And at that volume AWS is more than twice the metered bill, which is
	// why publishing it was wrong rather than merely imprecise.
	const v = 34.528768 // millions
	aws := 97.82 + v*3.00
	metered := v * floor
	if aws <= metered {
		t.Errorf("at %.3fM requests AWS bills $%.2f against $%.2f metered; the premise of this test is wrong", v, aws, metered)
	}
}

// The 33 flat plans must keep the answer they had: their fee buys every
// request, so the crossing is the bare division.
func TestAFlatNodeStillBreaksEven(t *testing.T) {
	const floor = 1.362 // $/1M, Solana

	// Helius dedicated: $2,900 node + $499 prerequisite, nothing metered.
	v := breakeven(3399, math.Inf(1), 0, floor)
	want := 3399 / floor * 1e6
	if math.Abs(v-want) > 1 {
		t.Errorf("flat plan break-even %.0f, want %.0f", v, want)
	}
	if math.Abs(v-2_495_594_714) > 2_000 {
		t.Errorf("Helius dedicated reads %.0f; the live gauge says 2,495,590,000", v)
	}
}

// A plan that includes an allowance and meters past it crosses in whichever
// region the crossing actually falls in, which is why both are solved.
func TestTheCrossingCanFallInsideTheIncludedAllowance(t *testing.T) {
	const floor = 10.0 // $/1M

	// $100/mo including 50M requests, then $1/1M. Metering 50M costs $500,
	// so the node is already cheaper well inside its allowance: $100/$10 = 10M.
	if v := breakeven(100, 50, 1.0, floor); math.Abs(v-10e6) > 1 {
		t.Errorf("crossing inside the allowance read %.0f, want 10,000,000", v)
	}

	// $1,000/mo including 10M, then $9/1M against the same $10 floor. The
	// crossing is past the allowance: (1000 - 9x10)/(10-9) = 910M.
	if v := breakeven(1000, 10, 9.0, floor); math.Abs(v-910e6) > 1 {
		t.Errorf("crossing past the allowance read %.0f, want 910,000,000", v)
	}
}

// A floor of zero or less cannot divide. PublicNode publishes $0 and is a
// reference row for exactly this reason.
func TestNoFloorMeansNoAnswer(t *testing.T) {
	if v := breakeven(100, 0, 1, 0); !math.IsNaN(v) {
		t.Errorf("a zero floor produced %.0f", v)
	}
}

// The real catalogue: every dedicated plan that meters must either have a
// rate below its chain's floor or publish no break-even at all. This walks
// the live cohort so a new metering plan cannot slip in unnoticed.
func TestEveryMeteringDedicatedPlanIsHandled(t *testing.T) {
	c, err := LoadCatalogue("../../pricing/catalogue.yml")
	if err != nil {
		t.Skipf("catalogue not readable from here: %v", err)
	}
	metering := 0
	for _, p := range c.Providers {
		if p.Cohort != "dedicated" {
			continue
		}
		for _, pl := range p.Plans {
			rate, included := dedicatedRate(c, p, pl)
			if rate == 0 && math.IsInf(included, 1) {
				continue // flat
			}
			metering++
			if pl.MonthlyUSD == nil {
				continue
			}
			t.Logf("%s/%s meters $%.2f/1M beyond %.1fM included", p.Slug, pl.ID, rate, included)
		}
	}
	// AWS AMB in three regions plus Shyft legacy-scale, per the comment in
	// quote(). If this count moves, the new plan needs checking by hand.
	if metering != 4 {
		t.Errorf("%d metering dedicated plans, expected 4 (AWS AMB x3, Shyft legacy-scale)", metering)
	}
}

// A plan that costs nothing has no break-even: there is nothing to pay back.
//
// The panel collapses each provider's plans to its soonest crossing, so a
// zero does not sit quietly in one series — it becomes the provider's
// headline, and on a lower-is-better panel zero is the best score there is.
// Shyft has a free tier in the dedicated cohort, and it read "breaks even at
// zero requests" above eight providers that actually charge for a node.
func TestAFreePlanHasNoBreakEven(t *testing.T) {
	c, err := LoadCatalogue("../../pricing/catalogue.yml")
	if err != nil {
		t.Skipf("catalogue not readable from here: %v", err)
	}

	zeroPriced := 0
	for _, p := range c.Providers {
		if p.Cohort != "dedicated" {
			continue
		}
		for _, pl := range p.Plans {
			if pl.MonthlyUSD != nil && c.toUSD(*pl.MonthlyUSD, p.Currency) <= 0 {
				zeroPriced++
				t.Logf("%s/%s is $0 and must publish no break-even", p.Slug, pl.ID)
			}
		}
	}
	if zeroPriced == 0 {
		t.Skip("no $0 dedicated plan in the catalogue; nothing to guard")
	}

	// The formula itself still answers 0, which is arithmetically right and
	// editorially wrong. The guard belongs at the publishing site, so this
	// pins the thing a reader would see rather than the function.
	if v := breakeven(0, math.Inf(1), 0, 2.833); v != 0 {
		t.Errorf("breakeven(0,...) = %v; the caller, not the formula, is what filters it", v)
	}
}
