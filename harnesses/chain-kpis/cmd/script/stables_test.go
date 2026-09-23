package main

import (
	"encoding/json"
	"math"
	"testing"
)

// series builds a daily stablecoin history ending at `last`, of length n,
// with the value `base` everywhere before the final day.
func series(n int, base, last float64) []float64 {
	v := make([]float64, n)
	for i := range v {
		v[i] = base
	}
	v[n-1] = last
	return v
}

func TestTheWindowsCountBackTheRightNumberOfDays(t *testing.T) {
	// 40 days at $100M, then today at $110M. Both windows start inside the
	// flat stretch, so both must read +10 %.
	s := stablesFromDaily(series(40, 100e6, 110e6))
	if !s.Has7d || !s.Has30d {
		t.Fatalf("a 40-day series should support both windows: %+v", s)
	}
	if math.Abs(s.Chg7d-10) > 1e-9 || math.Abs(s.Chg30d-10) > 1e-9 {
		t.Fatalf("chg7=%v chg30=%v, want 10 / 10", s.Chg7d, s.Chg30d)
	}
	if math.Abs(s.Net7d-10e6) > 1 || math.Abs(s.Net30d-10e6) > 1 {
		t.Fatalf("net7=%v net30=%v, want 10e6 / 10e6", s.Net7d, s.Net30d)
	}
	if s.Now != 110e6 {
		t.Fatalf("now = %v, want 110e6", s.Now)
	}
}

// The index is the part worth pinning: vals[n-8] is seven days back, not
// eight, and an off-by-one here is a wrong number that looks reasonable.
func TestSevenDaysBackIsSevenDaysBack(t *testing.T) {
	v := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10} // day 10 is today
	s := stablesFromDaily(v)
	// today 10, seven days back is day 3.
	if math.Abs(s.Net7d-7) > 1e-9 {
		t.Fatalf("net7 = %v, want 7 (10 - 3)", s.Net7d)
	}
	if s.Has30d {
		t.Fatalf("a 10-point series must not claim a 30-day window")
	}
}

// A chain DefiLlama started tracking last week would otherwise show a
// 30-day move measured against its own first data point, which reads as a
// flood of capital arriving rather than as a missing window.
func TestAShortHistoryPublishesNoChange(t *testing.T) {
	s := stablesFromDaily(series(5, 10e6, 90e6))
	if s.Has7d || s.Has30d {
		t.Fatalf("a 5-day series claimed a window: %+v", s)
	}
	if s.Now != 90e6 {
		t.Fatalf("the level itself should still publish, got %v", s.Now)
	}
}

// A zero base makes the percentage meaningless rather than infinite.
func TestAZeroBaseIsNotADivision(t *testing.T) {
	v := series(40, 0, 50e6)
	s := stablesFromDaily(v)
	if s.Has7d || s.Has30d {
		t.Fatalf("a zero base produced a percentage: %+v", s)
	}
}

func TestAFallingFloatIsNegative(t *testing.T) {
	s := stablesFromDaily(series(40, 100e6, 80e6))
	if s.Chg30d >= 0 || s.Net30d >= 0 {
		t.Fatalf("chg30=%v net30=%v; dollars leaving must read negative", s.Chg30d, s.Net30d)
	}
	if math.Abs(s.Chg30d+20) > 1e-9 {
		t.Fatalf("chg30 = %v, want -20", s.Chg30d)
	}
}

// The payload's `date` is a stringified unix timestamp on this endpoint
// while /v2/historicalChainTvl uses an int64. Decoding it as a number
// would fail the whole unmarshal and take the stables card with it.
func TestTheStablecoinPayloadShapeStillBinds(t *testing.T) {
	const body = `[{"date":"1787529600","totalCirculatingUSD":{"peggedUSD":4994231849.1}},
	               {"date":"1790121600","totalCirculatingUSD":{"peggedUSD":5019670590.4}}]`
	var arr []struct {
		Date                json.RawMessage `json:"date"`
		TotalCirculatingUSD struct {
			PeggedUSD float64 `json:"peggedUSD"`
		} `json:"totalCirculatingUSD"`
	}
	if err := json.Unmarshal([]byte(body), &arr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(arr) != 2 || arr[1].TotalCirculatingUSD.PeggedUSD == 0 {
		t.Fatalf("peggedUSD did not bind: %+v", arr)
	}
}
