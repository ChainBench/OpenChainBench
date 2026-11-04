package main

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// Why these tests exist at all.
//
// `WithLabelValues` panics at RUN TIME when the number of values does not
// match the declared labels. Adding `conn` to rpc_call_total touched four
// call sites, and the compiler is happy with any of them left behind: the
// probe would build, deploy, and then crash on the first tick that reached
// the stale site. So the cardinality is pinned here instead.
//
// The second rule is about meaning rather than shape. The counter and the
// two latency gauges must never disagree about which arm a sample belongs
// to, because the whole point of the label is that a cold-start row stops
// publishing the warm row's success rate and a sample count that is the sum
// of both arms (measured on ethereum us-east: warm 359 readings, cold 360,
// both rows showing 720).

func TestConnLabelMapsTheArm(t *testing.T) {
	if got := connLabel(true); got != connWarm {
		t.Fatalf("a warm tick must be labelled %q, got %q", connWarm, got)
	}
	if got := connLabel(false); got != connCold {
		t.Fatalf("a cold tick must be labelled %q, got %q", connCold, got)
	}
	// "none" is not reachable from connLabel on purpose: it marks a tick
	// where no call left, which only the quota guard can produce.
	if connNone == connWarm || connNone == connCold {
		t.Fatal("the three arm values must be distinct")
	}
}

func TestCallCounterTakesEveryCallSitesLabels(t *testing.T) {
	// Exactly the tuples the four call sites pass. If the declared label set
	// and a call site ever drift apart, one of these panics, which is the
	// failure that would otherwise happen in production.
	tuples := [][]string{
		// the measured call, both arms
		{"chainstack", "ethereum", "us-east", "ok", "keyed", connWarm},
		{"chainstack", "ethereum", "us-east", "ok", "keyed", connCold},
		// the quota guard before this tick's arm is chosen
		{"chainstack", "ethereum", "us-east", "quota_paused", "keyed", connNone},
		// the warm tick reserving its second request
		{"chainstack", "ethereum", "us-east", "quota_paused", "keyed", connWarm},
	}
	for _, tu := range tuples {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("rpc_call_total rejected %v: %v", tu, r)
				}
			}()
			rpcCallTotal.WithLabelValues(tu...).Inc()
		}()
	}

	// Four distinct tuples must be four distinct series, not one. A label
	// silently dropped from the declaration would collapse them and bring
	// back exactly the doubled sample count this change removes.
	if n := testutil.CollectAndCount(rpcCallTotal); n < len(tuples) {
		t.Fatalf("expected at least %d series, got %d: the arms are being collapsed",
			len(tuples), n)
	}
}
