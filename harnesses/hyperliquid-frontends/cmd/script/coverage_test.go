package main

import (
	"math"
	"testing"
	"time"
)

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
