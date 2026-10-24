package main

import "testing"

// The reach must be the same amount of TIME on every chain, which is the
// whole point: a flat block count is a different reach on each one, and that
// is what lost Robinhood.
//
// With a two-minute tick, 600 blocks covered 20 minutes of Base and 60
// seconds of Robinhood. Robinhood moves ~1,200 blocks in that interval, so
// the cursor was discarded every pass and about half of every interval was
// never read. The symptom was 12 pairs with bnb 9, ethereum 2, base 1 and
// none at all on the chain carrying most of the route.
func TestFillReachIsTheSameTimeOnEveryChain(t *testing.T) {
	for chain, sec := range mobulaBlockSeconds {
		span := mobulaSpanOf(chain)
		covered := float64(span) * sec
		if covered < float64(mobulaFillReach)*0.9 {
			t.Fatalf("%s: %d blocks at %.2f s covers %.0f s, under the %d s reach",
				chain, span, sec, covered, mobulaFillReach)
		}
		// And it must comfortably clear the two-minute tick, or the cursor
		// gets discarded and fills are skipped in silence.
		if covered < 300 {
			t.Fatalf("%s: %.0f s of reach is too close to the tick; a slow pass loses fills",
				chain, covered)
		}
	}
}

// A chain we have no block time for must read MORE chain, not less. Over
// reading costs an unknown_intent count; under reading loses fills and says
// nothing.
func TestUnknownChainGetsTheSlowAssumption(t *testing.T) {
	got := mobulaSpanOf("a-chain-we-have-never-seen")
	if got > mobulaSpanOf("robinhood") {
		t.Fatalf("an unknown chain got %d blocks, more than Robinhood's %d: that is the fast assumption",
			got, mobulaSpanOf("robinhood"))
	}
	if got <= 0 {
		t.Fatalf("an unknown chain got %d blocks, so its fills would never be read", got)
	}
}

// The reach must stay inside the deposit window, or the watcher reads fills
// whose intent could not possibly still be held and inflates unknown_intent
// with something that is not informative.
func TestFillReachStaysInsideTheDepositWindow(t *testing.T) {
	if mobulaFillReach >= mobulaIntentAge {
		t.Fatalf("the fill reach (%d s) is not shorter than the intent window (%d s): fills would be read that can never pair",
			mobulaFillReach, mobulaIntentAge)
	}
}

// And the span is capped, because a wrong block time must not ask an endpoint
// for a range it refuses: a rejected getLogs reads as a quiet bridge.
func TestSpanIsCapped(t *testing.T) {
	mobulaBlockSeconds["test-absurd"] = 0.0001
	defer delete(mobulaBlockSeconds, "test-absurd")
	if got := mobulaSpanOf("test-absurd"); got > 20000 {
		t.Fatalf("span %d is past the cap; the endpoint would refuse the range", got)
	}
}
