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
	n, err := parseSuiCheckpoint([]byte(`{"data":{"checkpoint":{"sequenceNumber":337642214,"timestamp":"2026-10-24T16:09:33.768Z"}}}`))
	if err != nil || n != 337642214 {
		t.Fatalf("got %d %v", n, err)
	}
	if _, err := parseSuiCheckpoint([]byte(`{"errors":[{"message":"boom"}]}`)); err == nil {
		t.Fatal("graphql error must surface")
	}
}
