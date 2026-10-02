package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// The freshness source must survive a restart, because the execution cycle
// runs once a day and the site noindexes a bench with no recorded run.
//
// This is not hypothetical. The file that provides it was dropped from main by
// a release commit that took "main's versions" of the harness while the benches
// stayed on dev, and production kept running an older binary that still had it.
// Deploying main surfaced the gap: both execution benches went to noindex
// within the hour, and their asOf read 1970.
func TestLastExecutionSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "last-execution.json")

	when := time.Unix(1790000000, 0)
	first := newLastExecStore(path)
	first.record("near-intents", "eu-west", when)

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("a recorded execution must reach disk, or a restart loses it: %v", err)
	}

	// A new process, as after a deploy.
	second := newLastExecStore(path)
	bridgeLastExecutionTs.Reset()
	second.expose("eu-west")

	var m dto.Metric
	if err := bridgeLastExecutionTs.WithLabelValues("near-intents", "eu-west").Write(&m); err != nil {
		t.Fatalf("reading the gauge: %v", err)
	}
	got := m.GetGauge().GetValue()
	if got != float64(when.Unix()) {
		t.Fatalf("after a restart the gauge must carry the persisted time: got %v want %v",
			got, float64(when.Unix()))
	}
}

// A store with nothing recorded must publish nothing rather than a zero. A
// zero unix time reads as 1970, which is exactly how the site decided the two
// benches were infinitely stale.
func TestEmptyStoreExposesNothing(t *testing.T) {
	bridgeLastExecutionTs.Reset()
	newLastExecStore(filepath.Join(t.TempDir(), "absent.json")).expose("eu-west")

	ch := make(chan prometheus.Metric, 8)
	bridgeLastExecutionTs.Collect(ch)
	close(ch)
	n := 0
	for range ch {
		n++
	}
	if n != 0 {
		t.Fatalf("an empty store must publish no series, got %d", n)
	}
}
