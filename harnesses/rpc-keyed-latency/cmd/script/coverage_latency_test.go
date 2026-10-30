package main

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// A latency next to a capability verdict is only honest for one of the three
// verdicts, and the reason is the same one the capability gauge rests on.
//
// A refused method has a round trip, and it is normally the fastest reading
// of the pass: "method not found" is produced by the front door without
// touching an index or an archive node. A provider that declines trace_block
// in 11 ms would therefore outrank one that serves it in 240, and the board
// would be reporting the speed of saying no. Worse, the two are
// indistinguishable once published: nothing in a millisecond value says
// whether anything was computed.
//
// So the rule is that a latency is written when the method was SERVED and at
// no other time, and absence has to stay absence rather than become a zero,
// because a zero here reads as an instant answer.
//
// These assertions count series instead of reading values, which is the only
// way to tell "not written" from "written as 0": asking a GaugeVec for a
// child creates it, so a test that reads the value it is checking for absence
// of brings it into existence first.
func seriesCount(t *testing.T) int {
	t.Helper()
	return testutil.CollectAndCount(rpcAPILatency)
}

func TestServedVerdictPublishesItsLatency(t *testing.T) {
	e := Endpoint{Provider: "test-served", Chain: "ethereum", Kind: "evm"}
	before := seriesCount(t)
	recordVerdict(e, "eth_getlogs_topics", verdictServed, 241.5)
	if got := seriesCount(t) - before; got != 1 {
		t.Fatalf("served should add exactly one latency series, added %d", got)
	}
	if got := testutil.ToFloat64(rpcAPILatency.WithLabelValues(
		e.Provider, e.Chain, "eth_getlogs_topics", currentRegion, tierKeyed)); got != 241.5 {
		t.Fatalf("latency published as %v, want the measured 241.5", got)
	}
	// And the capability verdict is still the one being made.
	if got := testutil.ToFloat64(rpcAPISupported.WithLabelValues(
		e.Provider, e.Chain, "eth_getlogs_topics", currentRegion, tierKeyed)); got != 1 {
		t.Fatalf("served capability gauge = %v, want 1", got)
	}
}

func TestRefusalPublishesNoLatency(t *testing.T) {
	// The measured case, in both shapes a refusal arrives in. A fast refusal
	// is the dangerous one, so the value handed in is deliberately quicker
	// than any served reading above.
	for _, tc := range []struct {
		name    string
		verdict string
	}{
		{"unsupported", verdictUnsupported},
		{"forbidden", verdictForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := Endpoint{Provider: "test-" + tc.name, Chain: "base", Kind: "evm"}
			before := seriesCount(t)
			recordVerdict(e, "trace_block", tc.verdict, 11.2)
			if got := seriesCount(t) - before; got != 0 {
				t.Fatalf("%s wrote %d latency series, want none: a refusal's round trip is the speed of saying no", tc.verdict, got)
			}
			// The verdict itself must still be published: withholding the
			// latency must not withhold the refusal, which is the fact the
			// board is built on.
			if got := testutil.ToFloat64(rpcAPISupported.WithLabelValues(
				e.Provider, e.Chain, "trace_block", currentRegion, tierKeyed)); got != 0 {
				t.Fatalf("%s capability gauge = %v, want 0", tc.verdict, got)
			}
		})
	}
}

func TestUnknownVerdictWritesNothing(t *testing.T) {
	// Timeout, paused quota, exhausted credits and an unusable key all arrive
	// here, and every one of them is our failure rather than the provider's.
	// A zero latency would be the same lie as a zero capability.
	e := Endpoint{Provider: "test-unknown", Chain: "polygon", Kind: "evm"}
	beforeLat := seriesCount(t)
	beforeCap := testutil.CollectAndCount(rpcAPISupported)
	recordVerdict(e, "archive_5m", verdictUnknown, 7.0)
	if got := seriesCount(t) - beforeLat; got != 0 {
		t.Fatalf("unknown verdict wrote %d latency series, want none", got)
	}
	if got := testutil.CollectAndCount(rpcAPISupported) - beforeCap; got != 0 {
		t.Fatalf("unknown verdict wrote %d capability series, want none", got)
	}
}

func TestDeferredAuthResolutionCarriesNoLatency(t *testing.T) {
	// coverEndpoint resolves a held 401/403 to forbidden once it knows the
	// credential works, and it reaches recordVerdict with 0 because the only
	// round trip it has is the auth refusal's. That 0 must not become a
	// published instant answer.
	e := Endpoint{Provider: "test-deferred", Chain: "arbitrum", Kind: "evm"}
	before := seriesCount(t)
	recordVerdict(e, "debug_tracetransaction", verdictForbidden, 0)
	if got := seriesCount(t) - before; got != 0 {
		t.Fatalf("deferred resolution wrote %d latency series, want none", got)
	}
}
