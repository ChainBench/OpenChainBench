package main

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

var now = time.Date(2026, 9, 27, 9, 0, 0, 0, time.UTC)

func dayUnix(y int, m time.Month, d int) float64 {
	return float64(time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix())
}

func TestDaysBehind(t *testing.T) {
	cases := []struct {
		name string
		day  float64
		want int
	}{
		{"today", dayUnix(2026, 9, 27), 0},
		{"yesterday", dayUnix(2026, 9, 26), 1},
		{"three days", dayUnix(2026, 9, 24), 3},
		{"the day the old source froze", dayUnix(2026, 8, 25), 33},
	}
	for _, c := range cases {
		if got := daysBehind(c.day, now); got != c.want {
			t.Errorf("%s: daysBehind = %d, want %d", c.name, got, c.want)
		}
	}
	// No day at all has to read as stale, not as current.
	if got := daysBehind(0, now); got <= 3 {
		t.Errorf("missing data day: daysBehind = %d, want a stale value", got)
	}
}

// A day inside the window publishes every figure; one outside it deletes them
// all and leaves health at 0, so the bench reads unresponsive instead of
// serving the old number as today's.
func TestPublishRowsDropsStaleDay(t *testing.T) {
	t.Cleanup(func() { dropPlatform("fresh"); dropPlatform("frozen") })

	rows := []duneRow{
		{Platform: "fresh", DataDayUnix: dayUnix(2026, 9, 26), VolumeUSD: 100, Txns: 4, FeesUSD: 1, Wallets: 2, AvgTradeUSD: 25, FeeRatePct: 1},
		{Platform: "frozen", DataDayUnix: dayUnix(2026, 8, 25), VolumeUSD: 999, Txns: 9, FeesUSD: 9, Wallets: 9, AvgTradeUSD: 111, FeeRatePct: 1},
	}
	published, dropped := publishRows(rows, 3, now, []string{"fresh", "frozen"})

	if len(published) != 1 || published[0] != "fresh" {
		t.Fatalf("published = %v, want [fresh]", published)
	}
	if len(dropped) != 1 || dropped[0] != "frozen" {
		t.Fatalf("dropped = %v, want [frozen]", dropped)
	}
	if got := testutil.ToFloat64(platformVolume.WithLabelValues("fresh")); got != 100 {
		t.Errorf("fresh volume = %v, want 100", got)
	}
	if got := testutil.ToFloat64(platformDataDay.WithLabelValues("fresh")); got != dayUnix(2026, 9, 26) {
		t.Errorf("fresh data day = %v, want 2026-09-26", got)
	}
	if got := testutil.ToFloat64(platformHealth.WithLabelValues("fresh")); got != 1 {
		t.Errorf("fresh health = %v, want 1", got)
	}
	if got := testutil.CollectAndCount(platformVolume, "dune_platform_volume_24h_usd"); got != 1 {
		t.Errorf("volume series count = %d, want 1 (the frozen child must be gone)", got)
	}
	if got := testutil.ToFloat64(platformHealth.WithLabelValues("frozen")); got != 0 {
		t.Errorf("frozen health = %v, want 0", got)
	}
}

// A platform the query stops returning is dropped as well: keeping the figures
// from the last poll that carried it is the same failure as a frozen day.
func TestPublishRowsDropsAbsentPlatform(t *testing.T) {
	t.Cleanup(func() { dropPlatform("kept"); dropPlatform("gone") })

	first := []duneRow{
		{Platform: "kept", DataDayUnix: dayUnix(2026, 9, 26), VolumeUSD: 10, Txns: 1, AvgTradeUSD: 10},
		{Platform: "gone", DataDayUnix: dayUnix(2026, 9, 26), VolumeUSD: 20, Txns: 2, AvgTradeUSD: 10},
	}
	publishRows(first, 3, now, []string{"kept", "gone"})
	if got := testutil.CollectAndCount(platformVolume, "dune_platform_volume_24h_usd"); got != 2 {
		t.Fatalf("volume series count = %d, want 2", got)
	}

	_, dropped := publishRows(first[:1], 3, now, []string{"kept", "gone"})
	if len(dropped) != 1 || dropped[0] != "gone" {
		t.Fatalf("dropped = %v, want [gone]", dropped)
	}
	if got := testutil.CollectAndCount(platformVolume, "dune_platform_volume_24h_usd"); got != 1 {
		t.Errorf("volume series count = %d, want 1", got)
	}
	if got := testutil.ToFloat64(platformHealth.WithLabelValues("gone")); got != 0 {
		t.Errorf("gone health = %v, want 0", got)
	}
}
