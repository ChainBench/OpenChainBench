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

// lastTradeAt is a data-day-end timestamp that dayCovered accepts.
func lastTradeAt(day float64) float64 { return day + 23*3600 + 59*60 }

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
		{Platform: "fresh", DataDayUnix: dayUnix(2026, 9, 26), DayLastTradeUnix: lastTradeAt(dayUnix(2026, 9, 26)), SolPriceUSD: 119, VolumeUSD: 100, Txns: 4, FeesUSD: 1, Wallets: 2, AvgTradeUSD: 25, FeeRatePct: 1},
		{Platform: "frozen", DataDayUnix: dayUnix(2026, 8, 25), DayLastTradeUnix: lastTradeAt(dayUnix(2026, 8, 25)), SolPriceUSD: 119, VolumeUSD: 999, Txns: 9, FeesUSD: 9, Wallets: 9, AvgTradeUSD: 111, FeeRatePct: 1},
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
		{Platform: "kept", DataDayUnix: dayUnix(2026, 9, 26), DayLastTradeUnix: lastTradeAt(dayUnix(2026, 9, 26)), SolPriceUSD: 119, VolumeUSD: 10, Txns: 1, AvgTradeUSD: 10},
		{Platform: "gone", DataDayUnix: dayUnix(2026, 9, 26), DayLastTradeUnix: lastTradeAt(dayUnix(2026, 9, 26)), SolPriceUSD: 119, VolumeUSD: 20, Txns: 2, AvgTradeUSD: 10},
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

// A day whose trades stop in the morning was only half loaded when the query ran.
// The data day alone cannot show that, because the harness chose it.
func TestPublishRowsDropsPartlyLoadedDay(t *testing.T) {
	t.Cleanup(func() { dropPlatform("partial") })

	day := dayUnix(2026, 9, 26)
	rows := []duneRow{{
		Platform: "partial", DataDayUnix: day, DayLastTradeUnix: day + 9*3600,
		SolPriceUSD: 119, VolumeUSD: 100, Txns: 4, AvgTradeUSD: 25,
	}}
	published, dropped := publishRows(rows, 3, now, []string{"partial"})
	if len(published) != 0 {
		t.Errorf("published = %v, want none", published)
	}
	if len(dropped) != 1 || dropped[0] != "partial" {
		t.Errorf("dropped = %v, want [partial]", dropped)
	}
	if got := testutil.ToFloat64(platformHealth.WithLabelValues("partial")); got != 0 {
		t.Errorf("health = %v, want 0", got)
	}
	// A row with no last trade at all is treated the same way.
	if dayCovered(duneRow{DataDayUnix: day}) {
		t.Error("a row with no last trade must not count as a covered day")
	}
}

// Without the day's SOL close the fee total is only its stablecoin part, so the
// fee figures are withheld while volume, which does not depend on a price, stays.
func TestPublishRowsWithholdsFeesWithoutASolPrice(t *testing.T) {
	t.Cleanup(func() { dropPlatform("nopx") })

	day := dayUnix(2026, 9, 26)
	rows := []duneRow{{
		Platform: "nopx", DataDayUnix: day, DayLastTradeUnix: lastTradeAt(day),
		SolPriceUSD: 0, VolumeUSD: 100, Txns: 4, FeesUSD: 0, AvgTradeUSD: 25, FeeRatePct: 0,
	}}
	published, _ := publishRows(rows, 3, now, []string{"nopx"})
	if len(published) != 1 {
		t.Fatalf("published = %v, want [nopx]", published)
	}
	if got := testutil.ToFloat64(platformVolume.WithLabelValues("nopx")); got != 100 {
		t.Errorf("volume = %v, want 100", got)
	}
	if got := testutil.CollectAndCount(platformFeesUSD, "dune_platform_fees_24h_usd"); got != 0 {
		t.Errorf("fee series = %d, want 0", got)
	}
	if got := testutil.CollectAndCount(platformFeeRate, "dune_platform_fee_rate_pct"); got != 0 {
		t.Errorf("fee rate series = %d, want 0", got)
	}
}

// The guard has to work on its own clock, not only on new data. A fetch that
// starts failing leaves the harness re-publishing the rows it last saw, and those
// have to age out: otherwise a rotated key or a Dune outage keeps yesterday's
// figures on the board reading as healthy, which is the failure this whole change
// exists to stop.
func TestPublishRowsAgesOutTheSameRowsAsTimePasses(t *testing.T) {
	t.Cleanup(func() { dropPlatform("held") })

	day := dayUnix(2026, 9, 26)
	rows := []duneRow{{
		Platform: "held", DataDayUnix: day, DayLastTradeUnix: lastTradeAt(day),
		SolPriceUSD: 119, VolumeUSD: 100, Txns: 4, AvgTradeUSD: 25,
	}}

	// Day after: inside the window.
	if published, _ := publishRows(rows, 3, now, []string{"held"}); len(published) != 1 {
		t.Fatalf("published = %v, want [held]", published)
	}
	if publishedDay != "2026-09-26" {
		t.Errorf("publishedDay = %q, want 2026-09-26", publishedDay)
	}

	// Four days later, the very same rows: outside it.
	later := now.AddDate(0, 0, 4)
	published, dropped := publishRows(rows, 3, later, []string{"held"})
	if len(published) != 0 {
		t.Errorf("published = %v, want none", published)
	}
	if len(dropped) != 1 || dropped[0] != "held" {
		t.Errorf("dropped = %v, want [held]", dropped)
	}
	if publishedDay != "" {
		t.Errorf("publishedDay = %q, want empty once nothing is on the board", publishedDay)
	}
	if got := testutil.CollectAndCount(platformVolume, "dune_platform_volume_24h_usd"); got != 0 {
		t.Errorf("volume series = %d, want 0", got)
	}
}

// A publish that had to withhold the fee figures is not a finished day: the
// refresh gate has to be able to retry it, so the published day is not recorded.
func TestPublishedDayWaitsForTheFeeFigures(t *testing.T) {
	t.Cleanup(func() { dropPlatform("nopx2"); publishedDay = "" })
	publishedDay = ""

	day := dayUnix(2026, 9, 26)
	rows := []duneRow{{
		Platform: "nopx2", DataDayUnix: day, DayLastTradeUnix: lastTradeAt(day),
		SolPriceUSD: 0, VolumeUSD: 100, Txns: 4, AvgTradeUSD: 25,
	}}
	if published, _ := publishRows(rows, 3, now, []string{"nopx2"}); len(published) != 1 {
		t.Fatalf("published = %v, want [nopx2]", published)
	}
	if publishedDay != "" {
		t.Errorf("publishedDay = %q, want empty while the fee figures are missing", publishedDay)
	}

	// With a price, the day counts as done.
	rows[0].SolPriceUSD = 119
	publishRows(rows, 3, now, []string{"nopx2"})
	if publishedDay != "2026-09-26" {
		t.Errorf("publishedDay = %q, want 2026-09-26", publishedDay)
	}
}

// Before anything is fetched every platform reads unresponsive rather than
// absent, so a deploy that lands before the indexing lag clears still says so and
// an alert on health == 0 has something to fire on.
func TestMarkAllUnresponsive(t *testing.T) {
	known := []string{"a1", "b2"}
	t.Cleanup(func() {
		for _, p := range known {
			dropPlatform(p)
		}
	})
	markAllUnresponsive(known)
	for _, p := range known {
		if got := testutil.ToFloat64(platformHealth.WithLabelValues(p)); got != 0 {
			t.Errorf("%s health = %v, want 0", p, got)
		}
	}
	if got := testutil.CollectAndCount(platformVolume, "dune_platform_volume_24h_usd"); got != 0 {
		t.Errorf("volume series = %d, want 0", got)
	}
}

// The row with no SOL price can come after one that has it. The day must still
// not be recorded, or the retry gate treats a half-priced day as finished.
func TestPublishedDayIsNotRecordedWhateverTheRowOrder(t *testing.T) {
	t.Cleanup(func() { dropPlatform("withpx"); dropPlatform("nopx3"); publishedDay = "" })

	day := dayUnix(2026, 9, 26)
	withPrice := duneRow{Platform: "withpx", DataDayUnix: day, DayLastTradeUnix: lastTradeAt(day), SolPriceUSD: 119, VolumeUSD: 10, Txns: 1, AvgTradeUSD: 10}
	noPrice := duneRow{Platform: "nopx3", DataDayUnix: day, DayLastTradeUnix: lastTradeAt(day), SolPriceUSD: 0, VolumeUSD: 20, Txns: 2, AvgTradeUSD: 10}

	for _, order := range [][]duneRow{{withPrice, noPrice}, {noPrice, withPrice}} {
		publishedDay = ""
		if published, _ := publishRows(order, 3, now, []string{"withpx", "nopx3"}); len(published) != 2 {
			t.Fatalf("published = %v, want both", published)
		}
		if publishedDay != "" {
			t.Errorf("order %s/%s: publishedDay = %q, want empty", order[0].Platform, order[1].Platform, publishedDay)
		}
	}
}

// publishableRows and publishRows have to agree, since one decides whether a
// result is worth taking and the other applies it.
func TestPublishableRowsAgreesWithPublishRows(t *testing.T) {
	day := dayUnix(2026, 9, 26)
	rows := []duneRow{
		{Platform: "ok1", DataDayUnix: day, DayLastTradeUnix: lastTradeAt(day), SolPriceUSD: 119, VolumeUSD: 1, Txns: 1, AvgTradeUSD: 1},
		{Platform: "partial", DataDayUnix: day, DayLastTradeUnix: day + 3600, SolPriceUSD: 119, VolumeUSD: 1, Txns: 1},
		{Platform: "old", DataDayUnix: dayUnix(2026, 8, 25), DayLastTradeUnix: lastTradeAt(dayUnix(2026, 8, 25)), SolPriceUSD: 119, VolumeUSD: 1, Txns: 1},
		{Platform: "", DataDayUnix: day, DayLastTradeUnix: lastTradeAt(day)},
	}
	t.Cleanup(func() {
		for _, r := range rows {
			dropPlatform(r.Platform)
		}
		publishedDay = ""
	})

	want, priced := publishableRows(rows, 3, now)
	published, _ := publishRows(rows, 3, now, nil)
	if want != len(published) {
		t.Errorf("publishableRows usable = %d, publishRows published %d", want, len(published))
	}
	if want != 1 {
		t.Errorf("publishableRows usable = %d, want 1 (only ok1)", want)
	}
	if priced != 1 {
		t.Errorf("publishableRows priced = %d, want 1", priced)
	}
}

// A result with no SOL price must not be counted as priced, so publish can tell
// it apart from one that carries its fee figures.
func TestPublishableRowsCountsPricedSeparately(t *testing.T) {
	day := dayUnix(2026, 9, 26)
	rows := []duneRow{
		{Platform: "p1", DataDayUnix: day, DayLastTradeUnix: lastTradeAt(day), SolPriceUSD: 119},
		{Platform: "p2", DataDayUnix: day, DayLastTradeUnix: lastTradeAt(day), SolPriceUSD: 0},
	}
	usable, priced := publishableRows(rows, 3, now)
	if usable != 2 || priced != 1 {
		t.Errorf("publishableRows = (%d, %d), want (2, 1)", usable, priced)
	}
	// Nothing held means nothing to compare against.
	if u, p := publishableRows(nil, 3, now); u != 0 || p != 0 {
		t.Errorf("publishableRows(nil) = (%d, %d), want (0, 0)", u, p)
	}
}

// The window cannot be set below 2: the target day is yesterday at best and two
// days back before the indexing lag clears, so a smaller window publishes nothing
// while the retry budget keeps buying executions.
func TestMaxDataAgeDaysIsAtLeastTwo(t *testing.T) {
	day := targetDay(time.Date(2026, 9, 27, 2, 0, 0, 0, time.UTC))
	r := duneRow{Platform: "x", DataDayUnix: float64(day.Unix()), DayLastTradeUnix: float64(day.Unix()) + 23*3600}
	if rowUsable(r, 1, time.Date(2026, 9, 27, 2, 0, 0, 0, time.UTC)) {
		t.Error("a 1-day window accepts the pre-lag target day, so the floor of 2 is not doing anything")
	}
	if !rowUsable(r, 2, time.Date(2026, 9, 27, 2, 0, 0, 0, time.UTC)) {
		t.Error("a 2-day window must accept the pre-lag target day")
	}
}

// A day the query saw only to 23:00 publishes but is not recorded as measured, so
// a retry can still replace it with a fuller read of the same day.
func TestAShortDayPublishesButIsNotRecorded(t *testing.T) {
	t.Cleanup(func() { dropPlatform("short"); publishedDay = "" })
	publishedDay = ""

	day := dayUnix(2026, 9, 26)
	rows := []duneRow{{
		Platform: "short", DataDayUnix: day, DayLastTradeUnix: day + 23*3600 + 10*60,
		SolPriceUSD: 119, VolumeUSD: 100, Txns: 4, AvgTradeUSD: 25,
	}}
	published, _ := publishRows(rows, 3, now, []string{"short"})
	if len(published) != 1 {
		t.Fatalf("published = %v, want [short] (23:00 is enough to publish)", published)
	}
	if publishedDay != "" {
		t.Errorf("publishedDay = %q, want empty for a day seen only to 23:10", publishedDay)
	}

	// Seen to the end, it is recorded.
	rows[0].DayLastTradeUnix = lastTradeAt(day)
	publishRows(rows, 3, now, []string{"short"})
	if publishedDay != "2026-09-26" {
		t.Errorf("publishedDay = %q, want 2026-09-26", publishedDay)
	}
}
