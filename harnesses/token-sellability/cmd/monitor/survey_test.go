package main

import "testing"

// Every token whose sale failed must be asked about, because the board's
// columns are computed over exactly those and silently dropping one shrinks a
// published denominator without saying so.
func TestEveryFailedTokenIsAskedAbout(t *testing.T) {
	examined := []string{"0xa", "0xb", "0xc", "0xd", "0xe"}
	failed := map[string][]string{"delayed": {"0xd"}, "same_block": {"0xe", "0xd"}}
	got := surveyCohort(examined, failed, 3)

	in := map[string]bool{}
	for _, t := range got {
		in[t] = true
	}
	for _, want := range []string{"0xd", "0xe"} {
		if !in[want] {
			t.Errorf("%s failed its sale and must be in the cohort, got %v", want, got)
		}
	}
	if len(got) != 3 {
		t.Errorf("the cap is 3, got %d", len(got))
	}
}

// A token appearing in both tiers is one token and must be asked about once.
// The old code asked per tier, which spent budget on an answer that does not
// depend on the timing.
func TestATokenInBothTiersIsAskedOnce(t *testing.T) {
	got := surveyCohort([]string{"0xa"},
		map[string][]string{"delayed": {"0xa"}, "same_block": {"0xa"}}, 10)
	if len(got) != 1 {
		t.Errorf("one token, one request, got %v", got)
	}
}

// The remaining budget is filled from the rest, so the coverage denominator
// grows instead of only ever describing the broken half of the cohort.
func TestTheBudgetIsFilledFromTheRest(t *testing.T) {
	got := surveyCohort([]string{"0xa", "0xb", "0xc"},
		map[string][]string{"delayed": {"0xc"}}, 3)
	if len(got) != 3 {
		t.Fatalf("expected the cap to be filled, got %v", got)
	}
	if got[0] != "0xc" {
		t.Errorf("the failed token comes first, got %v", got)
	}
}

// The cap binds. LI.FI allows 75 requests per 20 minutes and a sweep that
// ignores that empties the budget and then fails most of its own survey.
func TestTheCapIsNeverExceeded(t *testing.T) {
	examined := make([]string, 200)
	for i := range examined {
		examined[i] = string(rune('a' + i%26))
	}
	if got := surveyCohort(examined, nil, 40); len(got) != 40 {
		t.Errorf("cap 40, got %d", len(got))
	}
}

// Pacing comes from what each aggregator publishes or what was measured, and
// the slowest is what the sweep is built around.
func TestLifiIsTheSlowestPace(t *testing.T) {
	for _, faster := range []string{"sushi", "kyberswap", "paraswap", "trnch"} {
		if paceOf(faster) >= paceOf("lifi") {
			t.Errorf("%s should be paced faster than lifi", faster)
		}
	}
	if paceOf("trnch") < 2*paceOf("kyberswap") {
		t.Error("trnch states 30 per minute and must be slower than kyberswap")
	}
}
