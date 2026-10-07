package main

import (
	"math"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// readPlainGauge pulls the value back out of an unlabelled Gauge.
func readPlainGauge(t *testing.T, g prometheus.Gauge) float64 {
	t.Helper()
	var m dto.Metric
	if err := g.Write(&m); err != nil {
		t.Fatalf("read gauge: %v", err)
	}
	return m.GetGauge().GetValue()
}

// readGauge pulls one labelled value back out of a GaugeVec.
func readGauge(t *testing.T, g *prometheus.GaugeVec, labels ...string) float64 {
	t.Helper()
	var m dto.Metric
	if err := g.WithLabelValues(labels...).Write(&m); err != nil {
		t.Fatalf("read gauge %v: %v", labels, err)
	}
	return m.GetGauge().GetValue()
}

func utc(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// at returns the unix second of hh:mm:ss inside day.
func at(day time.Time, hh, mm, ss int) int64 {
	return day.Add(time.Duration(hh)*time.Hour + time.Duration(mm)*time.Minute + time.Duration(ss)*time.Second).Unix()
}

// The numbers are the real ones, read from Hyperliquid's published export
// for Trust Wallet (0x5af1…5f71) on 2026-10-04. They are the reason this
// check exists, so they are what it is tested against.
func TestDayCoverageOnTheRealFeed(t *testing.T) {
	cases := []struct {
		day        time.Time
		hh, mm, ss int
		wantHours  float64
		truncated  bool
		note       string
	}{
		{utc(2026, 9, 10), 23, 59, 57, 24.0, false, "whole day, the shape before the break"},
		{utc(2026, 9, 21), 23, 59, 54, 24.0, false, "last whole day published"},
		{utc(2026, 9, 22), 12, 27, 11, 12.45, true, "first truncated day"},
		{utc(2026, 9, 25), 12, 13, 31, 12.23, true, ""},
		{utc(2026, 9, 30), 12, 11, 42, 12.20, true, ""},
		{utc(2026, 10, 2), 12, 10, 58, 12.18, true, "the day the discrepancy was reported on"},
	}
	for _, c := range cases {
		got := dayCoverageHours(c.day, at(c.day, c.hh, c.mm, c.ss))
		if math.Abs(got-c.wantHours) > 0.01 {
			t.Errorf("%s: coverage = %.2f h, want %.2f (%s)", c.day.Format("2006-01-02"), got, c.wantHours, c.note)
		}
		if tr := got < coverageCompleteHours; tr != c.truncated {
			t.Errorf("%s: truncated = %v at %.2f h, want %v (%s)", c.day.Format("2006-01-02"), tr, got, c.truncated, c.note)
		}
	}
}

func TestCoverageEdges(t *testing.T) {
	d := utc(2026, 10, 2)
	if got := dayCoverageHours(d, 0); got != 0 {
		t.Errorf("no fill at all = %v, want 0", got)
	}
	// A day with no file must not read as a complete one.
	if 0 >= coverageCompleteHours {
		t.Error("zero coverage must count as truncated")
	}
	// Clock skew or a stray row must not invent coverage.
	if got := dayCoverageHours(d, d.Unix()-3600); got != 0 {
		t.Errorf("a fill before the day started = %v, want 0", got)
	}
	if got := dayCoverageHours(d, d.Unix()+30*3600); got != 24 {
		t.Errorf("a fill past the day's end = %v, want it clamped to 24", got)
	}
}

// The threshold has to let a genuinely quiet late evening through while
// still catching the real break. 23 h sits between them with room on both
// sides: the widest truncation seen is 12.45 h and a whole day is 24.
func TestThresholdSeparatesQuietFromTruncated(t *testing.T) {
	d := utc(2026, 10, 2)
	if dayCoverageHours(d, at(d, 23, 10, 0)) < coverageCompleteHours {
		t.Error("a cohort whose last fill is 23:10 is quiet, not truncated")
	}
	if dayCoverageHours(d, at(d, 12, 27, 11)) >= coverageCompleteHours {
		t.Error("12:27 is the real truncation and must be caught")
	}
}

// TestBiggestDaySkipsShortDays is the fomo case from 2026-10-07, with the
// real ledger figures. The published biggest day was 21 September at
// $72,232.94, and it won only because 21 September is one of the twelve days
// in the window the feed carried to midnight: 28 September carried more than
// that in its first twelve hours alone and was cut at 12:00, so it summed to
// $47,480 and lost. CoinMarketMan, reading a complete feed, put the peak on
// 6 October.
//
// A maximum over days of unequal length ranks coverage, not activity, so a
// day the feed cut short cannot win. The figure then means "the biggest day
// the feed carried whole", which is what the site says it is.
func TestBiggestDaySkipsShortDays(t *testing.T) {
	ledger := map[string]dayTotals{
		"20260920": {Fees: 41_018, Vol: 90e6, Fills: 1000, Users: 400},
		"20260921": {Fees: 72_232, Vol: 159e6, Fills: 2400, Users: 900},
		"20260928": {Fees: 47_480, Vol: 103e6, Fills: 1300, Users: 500},
		"20261006": {Fees: 25_287, Vol: 53e6, Fills: 1000, Users: 400},
	}
	short := map[string]bool{"20260928": true, "20261006": true}

	a := &Aggregator{}
	a.publishLedgerStats("fomo", ledger, short)
	if got := readGauge(t, hlBiggestDay, "fomo"); got != 72_232 {
		t.Fatalf("biggest day = %v, want the biggest whole day 72232", got)
	}
	if got := readGauge(t, hlBiggestDayAt, "fomo"); got != float64(utc(2026, 9, 21).Unix()) {
		t.Fatalf("biggest day at = %v, want 2026-09-21", got)
	}

	// Without the guard the same ledger would hand the title to whichever day
	// happened to be longest, so a short day that genuinely led must not win
	// on a number that is only a lower bound.
	ledger["20261006"] = dayTotals{Fees: 200_000, Vol: 400e6, Fills: 3000, Users: 1200}
	a.publishLedgerStats("fomo", ledger, short)
	if got := readGauge(t, hlBiggestDay, "fomo"); got != 72_232 {
		t.Fatalf("a short day won with %v; a half day is a lower bound, not a maximum", got)
	}

	// With no short days the behaviour is the plain maximum it always was.
	a.publishLedgerStats("fomo", ledger, map[string]bool{})
	if got := readGauge(t, hlBiggestDay, "fomo"); got != 200_000 {
		t.Fatalf("biggest day = %v, want 200000 when every day is whole", got)
	}
}

// TestCoverageCountSpansTheWholeWindow is the bug the disclosure note first
// shipped with: the count only looked at days whose files were still in the
// mirror, so it reported 12 short days out of 30 on 2026-10-07 while the
// archive showed 17. A disclosure that understates the thing it discloses is
// worse than none, because it reads as a bounded problem.
func TestCoverageCountSpansTheWholeWindow(t *testing.T) {
	D := utc(2026, 10, 6)
	windowStart := D.AddDate(0, 0, -29)

	st := &State{Version: 2}
	st.init()
	// Recorded on earlier passes, while the files were still fetchable. These
	// are the real last-fill times from the archive.
	for _, c := range []struct {
		day   time.Time
		hours float64
	}{
		{utc(2026, 9, 15), 12.15},
		{utc(2026, 9, 16), 12.15},
		{utc(2026, 9, 17), 23.78},
		{utc(2026, 9, 18), 12.14},
		{utc(2026, 9, 19), 23.97},
	} {
		st.setDayCoverage(dayKey(c.day), c.hours)
	}
	a := &Aggregator{state: st}

	// This pass can only reach the last few days.
	lastFill := map[string]int64{
		dayKey(utc(2026, 10, 4)): at(utc(2026, 10, 4), 12, 4, 17),
		dayKey(utc(2026, 10, 5)): at(utc(2026, 10, 5), 11, 59, 53),
		dayKey(D):                at(D, 12, 6, 23),
	}

	short := a.publishCoverage(D, windowStart, lastFill)

	// Three short days this pass plus three recorded earlier, and the two
	// whole days recorded earlier stay out.
	if len(short) != 6 {
		t.Fatalf("short days = %d, want 6 (3 from this pass, 3 from state)", len(short))
	}
	if got := readPlainGauge(t, hlTruncatedDaysWindow); got != 6 {
		t.Fatalf("truncated gauge = %v, want 6", got)
	}
	// Eight days were measured across the two sources. The other 22 in the
	// window were never measured, and must not inflate the denominator into
	// reading as 22 clean days.
	if got := readPlainGauge(t, hlCoverageDaysMeasured); got != 8 {
		t.Fatalf("measured gauge = %v, want 8", got)
	}
	// What this pass measured is kept for the passes after the files go away.
	if h, ok := st.dayCoverage(dayKey(D)); !ok || math.Abs(h-12.106) > 0.01 {
		t.Fatalf("coverage for the feed day not recorded: %v %v", h, ok)
	}
}
