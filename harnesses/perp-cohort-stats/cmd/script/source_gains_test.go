package main

import (
	"math"
	"testing"
	"time"
)

func TestGainsVolume24hFromRows_RealSeriesWithReindexes(t *testing.T) {
	// backend-global.gains.trade/api/stats?chainId=42161 on 2026-09-14:
	// nightly snapshots at ~23:37 UTC plus the live row at 21:35. The
	// +$29.2B (09-03) and +$26.6B (09-07) steps are history re-indexes.
	rows := []gainsStatsRow{
		{"2026-09-01T23:37:00.000Z", 0.543e9},
		{"2026-09-02T23:37:00.000Z", 0.572e9},
		{"2026-09-03T23:37:00.000Z", 29.772e9},
		{"2026-09-04T23:37:00.000Z", 29.837e9},
		{"2026-09-05T23:37:00.000Z", 29.867e9},
		{"2026-09-06T23:37:00.000Z", 29.928e9},
		{"2026-09-07T23:37:00.000Z", 56.519e9},
		{"2026-09-08T23:37:00.000Z", 56.565e9},
		{"2026-09-09T23:37:00.000Z", 56.615e9},
		{"2026-09-10T23:37:00.000Z", 56.687e9},
		{"2026-09-11T23:37:27.000Z", 56.8013e9},
		{"2026-09-12T23:37:33.000Z", 56.8366e9},
		{"2026-09-13T23:37:46.000Z", 56.8791e9},
		{"2026-09-14T21:35:48.000Z", 57.3593e9},
	}
	now := time.Date(2026, 9, 14, 22, 0, 0, 0, time.UTC)
	got := gainsVolume24hFromRows(rows, now)
	// Latest delta: 480.2M over 21.97 h, scaled to 24 h.
	hrs := time.Date(2026, 9, 14, 21, 35, 48, 0, time.UTC).Sub(time.Date(2026, 9, 13, 23, 37, 46, 0, time.UTC)).Hours()
	want := (57.3593e9 - 56.8791e9) * 24 / hrs
	if math.Abs(got-want) > 1 {
		t.Fatalf("got %.0f want %.0f", got, want)
	}
	if got > 1e9 {
		t.Fatalf("a re-index jump leaked into the 24h volume: %.0f", got)
	}
}

func TestGainsVolume24hFromRows_NewestIsReindex(t *testing.T) {
	rows := []gainsStatsRow{
		{"2026-09-10T23:37:00.000Z", 100e6},
		{"2026-09-11T23:37:00.000Z", 150e6},
		{"2026-09-12T23:37:00.000Z", 190e6},
		{"2026-09-13T23:37:00.000Z", 240e6},
		{"2026-09-14T23:37:00.000Z", 30_240e6}, // +$30B re-index
	}
	now := time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)
	got := gainsVolume24hFromRows(rows, now)
	if got != 50e6 {
		t.Fatalf("expected the previous clean day (50M), got %.0f", got)
	}
}

func TestGainsVolume24hFromRows_Degenerate(t *testing.T) {
	now := time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)
	if v := gainsVolume24hFromRows(nil, now); v != 0 {
		t.Fatalf("nil rows: %v", v)
	}
	if v := gainsVolume24hFromRows([]gainsStatsRow{{"2026-09-14T23:37:00.000Z", 5}}, now); v != 0 {
		t.Fatalf("single row: %v", v)
	}
	// Two rows, decreasing counter: no usable delta.
	rows := []gainsStatsRow{{"2026-09-13T23:37:00.000Z", 10}, {"2026-09-14T23:37:00.000Z", 5}}
	if v := gainsVolume24hFromRows(rows, now); v != 0 {
		t.Fatalf("decreasing: %v", v)
	}
	// Rows in the future (clock skew) are ignored.
	rows = []gainsStatsRow{{"2026-09-13T23:37:00.000Z", 10e6}, {"2026-09-14T23:37:00.000Z", 20e6}, {"2026-09-20T23:37:00.000Z", 900e6}}
	if v := gainsVolume24hFromRows(rows, now); v != 10e6 {
		t.Fatalf("future row: %v", v)
	}
}
