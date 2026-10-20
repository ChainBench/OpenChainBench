package main

import (
	"testing"
	"time"
)

// The metrics are package globals registered in init(), so re-registering
// would panic. Tests share them and reset the bookkeeping instead.
func resetHeadLagSeen() {
	headLagSeenMu.Lock()
	headLagSeen = map[[3]string]time.Time{}
	headLagSeenMu.Unlock()
}

func ageHeadLagEntry(aggregator, chain, region string, by time.Duration) {
	headLagSeenMu.Lock()
	headLagSeen[[3]string{aggregator, chain, region}] = time.Now().Add(-by)
	headLagSeenMu.Unlock()
}

func hasHeadLagEntry(aggregator, chain, region string) bool {
	headLagSeenMu.Lock()
	defer headLagSeenMu.Unlock()
	_, ok := headLagSeen[[3]string{aggregator, chain, region}]
	return ok
}

// A head-lag gauge is written per observed trade, so a feed that stops
// delivering leaves its last value standing for ever. On 2026-10-20 that held
// Mobula at 26.6 s on Solana in us-east for 76 minutes while the same feed
// read 0.2 s from eu-west and sgp: our own socket was dead and the page named
// a provider for it. The sweeper exists so that absence reads as absent.
func TestSweepDropsAStaleRegionAndKeepsTheLiveOne(t *testing.T) {
	resetHeadLagSeen()
	headLagSeconds.Reset()

	RecordHeadLag("mobula", "solana", 0, 26.6, "us-east", "0xdead")
	RecordHeadLag("mobula", "solana", 0, 0.2, "eu-west", "0xbeef")

	// Age only us-east, which is what a one-region stall looks like: the
	// other probes are still writing.
	ageHeadLagEntry("mobula", "solana", "us-east", 11*time.Minute)

	dropped := sweepStaleHeadLag(time.Now().Add(-headLagStaleAfter))
	if len(dropped) != 1 || dropped[0] != [3]string{"mobula", "solana", "us-east"} {
		t.Fatalf("only the stale us-east series should drop, got %v", dropped)
	}
	if hasHeadLagEntry("mobula", "solana", "us-east") {
		t.Fatal("a swept series must be forgotten, not left armed")
	}
	if !hasHeadLagEntry("mobula", "solana", "eu-west") {
		t.Fatal("the live region must be untouched")
	}
}

// A feed that comes back must publish again without anyone re-arming it by
// hand, otherwise the sweeper turns a ten minute outage into a permanent one.
func TestASweptSeriesReturnsOnTheNextWrite(t *testing.T) {
	resetHeadLagSeen()
	headLagSeconds.Reset()

	RecordHeadLag("serialized", "base", 0, 1.1, "us-east", "0x1")
	ageHeadLagEntry("serialized", "base", "us-east", 11*time.Minute)
	if n := len(sweepStaleHeadLag(time.Now().Add(-headLagStaleAfter))); n != 1 {
		t.Fatalf("setup: expected one sweep, got %d", n)
	}

	RecordHeadLag("serialized", "base", 0, 0.4, "us-east", "0x2")
	if !hasHeadLagEntry("serialized", "base", "us-east") {
		t.Fatal("the feed came back; the write must re-arm it")
	}
	if dropped := sweepStaleHeadLag(time.Now().Add(-headLagStaleAfter)); len(dropped) != 0 {
		t.Fatalf("a re-armed series must survive the next sweep, dropped %v", dropped)
	}
}

// RecordHeadLag refuses readings outside its filter. Those must not arm the
// sweeper either, or a rejected reading would schedule the deletion of a
// series it never wrote.
func TestARejectedReadingDoesNotArmTheSweeper(t *testing.T) {
	resetHeadLagSeen()

	RecordHeadLag("okx", "bnb", 0, 900, "sgp", "0x3") // over the 120 s cap
	if hasHeadLagEntry("okx", "bnb", "sgp") {
		t.Fatal("a reading the filter rejected must not be tracked for sweeping")
	}
	RecordHeadLag("okx", "bnb", 0, -1, "sgp", "0x4") // below zero
	if hasHeadLagEntry("okx", "bnb", "sgp") {
		t.Fatal("a negative reading must not be tracked either")
	}
}

// The threshold matches the per-monitor watchdogs that already existed for
// okx, serialized, birdeye and codex, so one policy governs every feed
// instead of four names each carrying their own.
func TestSweepThresholdMatchesTheMonitorWatchdogs(t *testing.T) {
	if headLagStaleAfter != 10*time.Minute {
		t.Fatalf("the sweeper should share the monitors' 10 minute policy, got %s", headLagStaleAfter)
	}
}
