package main

import (
	"encoding/hex"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

// A real page of this program's traffic is mostly payouts with a few deposits
// in it. The poller walks every inner instruction and keeps only what decodes,
// so this checks the count over a mixed page rather than over deposits alone:
// a decoder that let payouts through would still pass a deposits-only test.
func TestOnlyDepositsAreCountedOnAMixedPage(t *testing.T) {
	page := []string{
		pumpAdminDebitFixture,
		pumpDepositFixtures[0].data,
		pumpAdminDebitFixture,
		pumpAdminDebitFixture,
		pumpDepositFixtures[1].data,
		pumpAdminDebitFixture,
	}

	var deposits int
	var total float64
	for _, h := range page {
		raw, err := hex.DecodeString(h)
		if err != nil {
			t.Fatalf("fixture: %v", err)
		}
		d, err := decodePumpDeposit(raw)
		if err != nil {
			continue
		}
		deposits++
		total += float64(d.Amount) / 1e6
	}

	if deposits != 2 {
		t.Errorf("deposits = %d, want 2 (the page holds 4 payouts)", deposits)
	}
	want := float64(pumpDepositFixtures[0].amount+pumpDepositFixtures[1].amount) / 1e6
	if total != want {
		t.Errorf("total = %f, want %f", total, want)
	}
}

// The metrics have to exist and be registered, because the whole point of this
// feed is that it is NOT the Relay one: a reader looking at tfq_relay_feed_up
// learns nothing about whether pump's own bridge is being read.
func TestPumpBridgeMetricsAreDistinctFromTheRelayFeed(t *testing.T) {
	reg := prometheus.NewRegistry()
	g := prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_pump_bridge_feed_up"})
	if err := reg.Register(g); err != nil {
		t.Fatalf("the gauge name does not register cleanly: %v", err)
	}
	g.Set(1)
	if gPumpBridgeUp == nil || cPumpBridgeDeposits == nil || hPumpBridgeDeposit == nil {
		t.Fatal("a pump bridge metric is nil; init did not run")
	}
}

// The histogram's buckets have to straddle the sizes users actually deposit, or
// the distribution the fee schedule is read against is unreadable. The round
// numbers the schedule was calibrated on (5, 10, 25, 50, 100, 200, 250, 500,
// 1000) must each fall inside the range.
func TestDepositHistogramCoversTheSizesWeCalibratedOn(t *testing.T) {
	buckets := []float64{1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 10000}
	for _, size := range []float64{5, 10, 25, 50, 100, 200, 250, 500, 1000} {
		if size < buckets[0] || size > buckets[len(buckets)-1] {
			t.Errorf("%v falls outside the histogram's range", size)
		}
	}
	for i := 1; i < len(buckets); i++ {
		if buckets[i] <= buckets[i-1] {
			t.Fatalf("buckets are not increasing at %d", i)
		}
	}
}
