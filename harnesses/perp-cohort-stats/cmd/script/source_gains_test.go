package main

import (
	"math"
	"testing"
	"time"
)

func TestGainsVolume24hFromDays_Blend(t *testing.T) {
	// 2026-09-14 on the Gains backend: auto+direct = 151.9M for the full
	// day, 09-13 = 37.4M (the figure bench 266 stores for that day).
	yesterday, today := 37.35e6, 151.9e6

	// At 18:00 UTC: today + 6/24 of yesterday.
	now := time.Date(2026, 9, 14, 18, 0, 0, 0, time.UTC)
	got := gainsVolume24hFromDays(today, yesterday, true, now)
	want := today + yesterday*6/24
	if math.Abs(got-want) > 1 {
		t.Fatalf("got %.0f want %.0f", got, want)
	}

	// Just after midnight: yesterday's full day dominates.
	now = time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)
	if got := gainsVolume24hFromDays(0, today, true, now); math.Abs(got-today) > 1 {
		t.Fatalf("midnight: got %.0f want %.0f", got, today)
	}
}

func TestGainsVolume24hFromDays_YesterdayMissing(t *testing.T) {
	early := time.Date(2026, 9, 14, 6, 0, 0, 0, time.UTC)
	if v := gainsVolume24hFromDays(10e6, 0, false, early); v != 0 {
		t.Fatalf("a quarter day must not be published as 24h: %v", v)
	}
	late := time.Date(2026, 9, 14, 22, 0, 0, 0, time.UTC)
	if v := gainsVolume24hFromDays(10e6, 0, false, late); v != 10e6 {
		t.Fatalf("late in the day today alone is close enough: %v", v)
	}
}

func TestGainsVolume24hFromDays_Degenerate(t *testing.T) {
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	if v := gainsVolume24hFromDays(0, 0, true, now); v != 0 {
		t.Fatalf("no volume: %v", v)
	}
	if v := gainsVolume24hFromDays(-5, -5, true, now); v != 0 {
		t.Fatalf("negative: %v", v)
	}
}
