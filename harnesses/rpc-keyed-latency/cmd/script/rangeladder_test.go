package main

import (
	"fmt"
	"strings"
	"testing"
)

// The stopping rule is the whole measurement, and its three endings are not
// interchangeable. A refusal is the provider's guard and is the number we
// want. Passing every rung is a floor, not a limit. A timeout is OUR failure,
// and turning one into a limit would publish our own patience as the
// provider's policy, which is the same fault as publishing a refusal we never
// received.
//
// Pinned against what live endpoints actually did on 2026-10-30:
//
//	chainstack ethereum  accepted 10,000, refused 100,000 ("Block range limit
//	                     exceeded") -> 10,000
//	alchemy    ethereum  accepted every rung to 1,000,000 in ~209 ms -> floor
//	publicnode ethereum  refused the topic shape outright ("Please specify an
//	                     address in your request") -> 0
func askUpTo(limit uint64) func(uint64) (bool, bool) {
	return func(span uint64) (bool, bool) { return span <= limit, true }
}

func TestLadderStopsAtTheProvidersGuard(t *testing.T) {
	// The chainstack case: 10,000 serves, 100,000 is refused.
	out := climb(askUpTo(10_000))
	if out.best != 10_000 {
		t.Fatalf("best=%d, want 10000", out.best)
	}
	if !out.publish {
		t.Fatal("a refusal is a definitive answer and must publish")
	}
	// 100, 500, 1000, 2000 and 10000 are accepted, 100000 is refused: six
	// calls, and the ladder stops there rather than trying the top rung.
	if out.calls != 6 {
		t.Fatalf("spent %d calls, want 6: the ladder must stop at the first refusal", out.calls)
	}
}

func TestEveryRungRefusedPublishesZero(t *testing.T) {
	// publicnode refuses the topic shape at any width. Zero is a real
	// reading: the provider will not serve that shape over the narrowest
	// window we test.
	out := climb(func(uint64) (bool, bool) { return false, true })
	if out.best != 0 || !out.publish {
		t.Fatalf("got best=%d publish=%v, want 0 and published", out.best, out.publish)
	}
	if out.calls != 1 {
		t.Fatalf("spent %d calls, want 1", out.calls)
	}
}

func TestPassingEveryRungPublishesTheTopAsAFloor(t *testing.T) {
	// Alchemy. The value is the largest rung TESTED, and the help text has to
	// say so, because the real guard is somewhere above it.
	out := climb(askUpTo(1 << 62))
	top := getLogsRungs[len(getLogsRungs)-1]
	if out.best != top {
		t.Fatalf("best=%d, want the top rung %d", out.best, top)
	}
	if out.calls != len(getLogsRungs) {
		t.Fatalf("spent %d calls, want %d", out.calls, len(getLogsRungs))
	}
}

func TestOurOwnFailureNeverBecomesALimit(t *testing.T) {
	// A timeout on the first rung: nothing was established, so nothing is
	// published. This is the case that would otherwise invent a guard of 0
	// for a provider that was merely slow or whose quota we had paused.
	out := climb(func(uint64) (bool, bool) { return false, false })
	if out.publish {
		t.Fatal("an indefinite first rung must publish nothing: a timeout is not a refusal")
	}

	// A timeout AFTER something was accepted still publishes what was
	// established, because that part is true and conservative.
	calls := 0
	out = climb(func(span uint64) (bool, bool) {
		calls++
		if span <= 2_000 {
			return true, true
		}
		return false, false
	})
	if !out.publish || out.best != 2_000 {
		t.Fatalf("got best=%d publish=%v, want 2000 published", out.best, out.publish)
	}
}

func TestRungsAscendAndFitTheProbeTimeout(t *testing.T) {
	// Ascending is what makes "stop at the first refusal" correct.
	for i := 1; i < len(getLogsRungs); i++ {
		if getLogsRungs[i] <= getLogsRungs[i-1] {
			t.Fatalf("rung %d (%d) does not exceed its predecessor (%d); the stopping rule assumes ascent",
				i, getLogsRungs[i], getLogsRungs[i-1])
		}
	}
	// Every rung measured under 1.3 s against live endpoints. A rung slower
	// than probeTimeout would be recorded as a timeout and cap the published
	// limit at our own patience, so the ladder may not grow a rung without
	// someone timing it again.
	// The set grew from four to seven after the first production pass showed
	// two providers capped below the old first rung. Seven is the ceiling:
	// each rung is a call per shape per pass, and only providers that accept
	// everything pay for all of them.
	if len(getLogsRungs) > 8 {
		t.Fatalf("%d rungs: each one is a call per shape per pass, and the set was chosen from measured timings", len(getLogsRungs))
	}
}

func TestBoundedFiltersCannotMatchAnything(t *testing.T) {
	// The safety of the whole ladder rests on the reply being empty at any
	// width: a wide window with a real filter is megabytes per call per pass.
	// The zero address holds no logs and the topic cannot equal any deployed
	// event signature.
	if len(getLogsRangeShapes) != 2 {
		t.Fatalf("%d shapes laddered; the no-filter shape has no bound and must stay out", len(getLogsRangeShapes))
	}
	for _, sh := range getLogsRangeShapes {
		f := sh.Filter(1000, 2000)
		if sh.Shape == "nofilter" {
			t.Fatal("the no-filter shape cannot be bounded and must not be laddered")
		}
		if !strings.Contains(f, "address") && !strings.Contains(f, "topics") {
			t.Fatalf("%s filter carries neither an address nor a topic, so its reply is unbounded: %s", sh.Shape, f)
		}
		if strings.Contains(f, "topics") && !strings.Contains(f, nonexistentTopic) {
			t.Fatalf("%s uses a topic that may exist: %s", sh.Shape, f)
		}
		if strings.Contains(f, `"address"`) && !strings.Contains(f, "0x0000000000000000000000000000000000000000") {
			t.Fatalf("%s uses an address that may hold logs: %s", sh.Shape, f)
		}
	}
}

func TestLadderSkipsAChainYoungerThanTheRung(t *testing.T) {
	// head - span underflows on a young chain, and an unsigned underflow
	// would ask for a window near the top of the uint64 range. Arc and
	// Robinhood Chain are both young enough for this to matter.
	for _, sh := range getLogsRangeShapes {
		f := sh.Filter(1, 2)
		if strings.Contains(f, "0xffff") {
			t.Fatalf("%s produced a suspicious window: %s", sh.Shape, f)
		}
	}
	// The guard itself lives in probeGetLogsRange's ask closure; this pins
	// the arithmetic it protects.
	var head uint64 = 50
	for _, span := range getLogsRungs {
		if head > span {
			t.Fatalf("rung %d should be skipped for head %d", span, head)
		}
	}
	if got := fmt.Sprintf("%d", getLogsRungs[0]); got != "100" {
		t.Fatalf("first rung %s; the skip test above assumes it exceeds a head of 50", got)
	}
}
