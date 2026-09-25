package main

import (
	"math"
	"testing"
	"time"
)

func day(n int) time.Time {
	return time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, n)
}

func ms(t time.Time) float64 { return float64(t.UnixMilli()) }

// A linear series: supply grows 1 unit a day from 1000. The derived
// series is mcap / price, so the fixture prices are arbitrary and the
// caps are price x supply.
func linearSeries(days int) (prices, mcaps [][2]float64) {
	for i := 0; i < days; i++ {
		price := 2.0 + float64(i%5)
		supply := 1000 + float64(i)
		prices = append(prices, [2]float64{ms(day(i)), price})
		mcaps = append(mcaps, [2]float64{ms(day(i)), price * supply})
	}
	return
}

// The supply series is mcap / price on matching timestamps. A price
// without a cap (a listing before CoinGecko tracked its supply) yields no
// point rather than a zero, which would read as a burn to nothing.
func TestSupplySeriesDividesCapByPriceAndSkipsZeros(t *testing.T) {
	prices, mcaps := linearSeries(5)
	mcaps[2][1] = 0                                    // a day with no cap
	prices = append(prices, [2]float64{ms(day(9)), 3}) // a price with no cap at all

	s := supplySeries(prices, mcaps)
	if len(s) != 4 {
		t.Fatalf("got %d points, want 4 (one zero-cap day dropped)", len(s))
	}
	for _, p := range s {
		want := 1000 + float64(p.T.Sub(day(0)).Hours()/24)
		if math.Abs(p.Circ-want) > 1e-6 {
			t.Errorf("%s: circ = %v, want %v", p.T.Format("01-02"), p.Circ, want)
		}
	}
}

func TestSupplyChangeReadsTheWindowBack(t *testing.T) {
	prices, mcaps := linearSeries(92) // day 0 .. day 91
	s := supplySeries(prices, mcaps)
	now := day(91).Add(13 * time.Hour) // an intraday "now" after the last daily point

	got30, ok := supplyChangePct(s, now, 30*24*time.Hour)
	if !ok {
		t.Fatal("30d change should exist on a 92-day series")
	}
	// Latest is day 91 (1091); the last point at or before now-30d
	// (day 61 13:00) is day 61 (1061).
	want30 := 100 * (1091.0/1061 - 1)
	if math.Abs(got30-want30) > 1e-9 {
		t.Errorf("30d = %v, want %v", got30, want30)
	}
	got90, ok := supplyChangePct(s, now, 90*24*time.Hour)
	if !ok {
		t.Fatal("90d change should exist on a 92-day series")
	}
	want90 := 100 * (1091.0/1001 - 1)
	if math.Abs(got90-want90) > 1e-9 {
		t.Errorf("90d = %v, want %v", got90, want90)
	}
}

// A series shorter than the window has no figure. Publishing 0 would say
// "no dilution" about a token that listed last month.
func TestSupplyChangeIsAbsentWhenTheSeriesIsShort(t *testing.T) {
	prices, mcaps := linearSeries(40)
	s := supplySeries(prices, mcaps)
	now := day(39).Add(13 * time.Hour)

	if _, ok := supplyChangePct(s, now, 30*24*time.Hour); !ok {
		t.Error("40 days of history should carry a 30d change")
	}
	if v, ok := supplyChangePct(s, now, 90*24*time.Hour); ok {
		t.Errorf("40 days of history should carry no 90d change, got %v", v)
	}
	if _, ok := supplyChangePct(s[:1], now, 30*24*time.Hour); ok {
		t.Error("a single point is not a change")
	}
	if _, ok := supplyChangePct(nil, now, 30*24*time.Hour); ok {
		t.Error("an empty series is not a change")
	}
}

// A flat supply is a zero change, and a burn is negative: the sign is
// what the column is for.
func TestSupplyChangeSign(t *testing.T) {
	var prices, mcaps [][2]float64
	for i := 0; i < 40; i++ {
		supply := 1000.0
		if i >= 35 {
			supply = 900 // a burn five days ago
		}
		prices = append(prices, [2]float64{ms(day(i)), 5})
		mcaps = append(mcaps, [2]float64{ms(day(i)), 5 * supply})
	}
	s := supplySeries(prices, mcaps)
	got, ok := supplyChangePct(s, day(39).Add(time.Hour), 30*24*time.Hour)
	if !ok || math.Abs(got-(-10)) > 1e-9 {
		t.Errorf("got %v ok=%v, want -10", got, ok)
	}
}

// The cache serves a token for the day it was fetched and forgets every
// entry at the UTC day boundary, which is what bounds the CoinGecko
// budget to one call per token per day.
func TestSupplyCacheResetsAtTheDayBoundary(t *testing.T) {
	c := newSupplyCache()
	series := []supplyPoint{{T: day(0), Circ: 1}}
	c.put("aave", "2026-09-25", series)
	if _, ok := c.get("aave", "2026-09-25"); !ok {
		t.Fatal("same day should hit")
	}
	if _, ok := c.get("uniswap", "2026-09-25"); ok {
		t.Fatal("another token should miss")
	}
	if _, ok := c.get("aave", "2026-09-26"); ok {
		t.Fatal("the next day should miss")
	}
	if c.size() != 0 {
		t.Fatalf("cache should be empty after the day rolled, has %d", c.size())
	}
}

// The pacer widens on a 429 and narrows back only after a run of clean
// calls, and never leaves [cgMinGap, cgMaxGap].
func TestPacerAdaptsToThrottling(t *testing.T) {
	p := &cgPacer{gap: cgMinGap}
	p.throttled()
	if p.gap != 2*cgMinGap {
		t.Fatalf("gap after one 429 = %v, want %v", p.gap, 2*cgMinGap)
	}
	for i := 0; i < 10; i++ {
		p.throttled()
	}
	if p.gap != cgMaxGap {
		t.Fatalf("gap should cap at %v, got %v", cgMaxGap, p.gap)
	}
	for i := 0; i < cgRelaxAfter-1; i++ {
		p.ok()
	}
	if p.gap != cgMaxGap {
		t.Fatalf("gap should hold until %d clean calls, moved at %d", cgRelaxAfter, cgRelaxAfter-1)
	}
	p.ok()
	if p.gap != cgMaxGap/2 {
		t.Fatalf("gap after %d clean calls = %v, want %v", cgRelaxAfter, p.gap, cgMaxGap/2)
	}
	for i := 0; i < 20*cgRelaxAfter; i++ {
		p.ok()
	}
	if p.gap != cgMinGap {
		t.Fatalf("gap should floor at %v, got %v", cgMinGap, p.gap)
	}
}
