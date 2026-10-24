package main

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// A rollup finalizes ~10,000 blocks at once. The last block of the batch has
// the smallest lag, so publishing it would understate finality every time.
func TestBatchFinalityPublishesTheMedian(t *testing.T) {
	st := &wsState{slug: "robinhood-test", firstSeen: map[int64]time.Time{}, batch: true}
	now := time.Now()
	st.recordFinal(100, now) // first reading after connect only anchors
	for i, ago := range []time.Duration{30, 20, 10} {
		st.firstSeen[int64(101+i)] = now.Add(-ago * time.Second)
	}
	before := testutil.ToFloat64(wallClockSampleCtr.WithLabelValues("robinhood-test"))
	st.recordFinal(103, now)
	if got := testutil.ToFloat64(wallClockLagGauge.WithLabelValues("robinhood-test")); got != 20000 {
		t.Fatalf("gauge %v, want the batch median 20000", got)
	}
	if got := testutil.ToFloat64(wallClockSampleCtr.WithLabelValues("robinhood-test")) - before; got != 3 {
		t.Fatalf("samples %v, want 3", got)
	}
}

func TestFirstFinalizedOnlyAnchors(t *testing.T) {
	st := &wsState{slug: "anchor-test", firstSeen: map[int64]time.Time{}}
	st.recordFinal(98_000_000, time.Now())
	if st.lastFinal != 98_000_000 {
		t.Fatalf("lastFinal %d", st.lastFinal)
	}
}

func TestParseSuiCheckpoint(t *testing.T) {
	n, ts, err := parseSuiCheckpoint([]byte(`{"data":{"checkpoint":{"sequenceNumber":337642214,"timestamp":"2026-10-24T16:09:33.768Z"}}}`))
	if err != nil || n != 337642214 || ts.UnixMilli()%1000 != 768 {
		t.Fatalf("got %d %v %v", n, ts, err)
	}
	if _, _, err := parseSuiCheckpoint([]byte(`{"errors":[{"message":"boom"}]}`)); err == nil {
		t.Fatal("graphql error must surface")
	}
}

// Three checkpoints 450 ms apart in commit time, seen in one poll, are a
// 150 ms cadence, whatever the poll interval.
func TestSuiIntervalFromTimestamps(t *testing.T) {
	st := &suiWSState{}
	t0 := time.Now()
	if _, ok := st.advance(100, t0); ok {
		t.Fatal("first reading must only anchor")
	}
	ms, ok := st.advance(103, t0.Add(450*time.Millisecond))
	if !ok || ms != 150 {
		t.Fatalf("got %v %v, want 150", ms, ok)
	}
	if _, ok := st.advance(103, t0.Add(time.Second)); ok {
		t.Fatal("no new checkpoint, no sample")
	}
}
