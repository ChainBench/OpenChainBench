package main

import (
	"encoding/json"
	"math"
	"testing"
)

// Real shape and real magnitudes from the live endpoint on 2026-10-12. The
// counters are cumulative and the final bucket is still filling, which is the
// trap these tests exist to pin: taking the last two elements would publish a
// part-day as a full day and understate the venue.
const papertradeProtocolFixture = `{
  "startMs": 1791244800000,
  "intervalMs": 86400000,
  "columns": {
    "volume": [0, 0, 0, 0, 564230133196.0, 741490668334.7, 831948472533.0],
    "tvl":    [0, 10553.0, 8068098.3, 51862154.1, 104885161.0, 64910434.9, 58716051.0],
    "trades": [0, 0, 0, 0, 87211, 235390, 322644]
  }
}`

// The house payload uses a different time encoding in the same API: baseTimeMs
// plus an explicit offsets array rather than startMs plus a fixed interval.
const papertradeHouseFixture = `{
  "intervalMs": 86400000,
  "baseTimeMs": 1791331200000,
  "timeOffsetsMs": [0, 86400000, 172800000, 259200000, 345600000],
  "columns": {
    "bl": [0, 0, 0, 1044421705.5, 181469913.9],
    "bs": [0, 0, 0, 942540852.7, 107941992.6],
    "el": [0, 0, 0, 1127792210.2, 91664310.6],
    "es": [0, 0, 0, 1236100455.6, 66687413.8],
    "lp": [0, 0, 0, 3118460.6, 4282099.4],
    "q":  [0, 0, 0, 0, 0]
  }
}`

func parseFixture(t *testing.T, raw string) *papertradeHistory {
	t.Helper()
	var h papertradeHistory
	if err := json.Unmarshal([]byte(raw), &h); err != nil {
		t.Fatalf("fixture does not parse: %v", err)
	}
	return &h
}

func TestPapertradeLastCompleteSkipsThePartialBucket(t *testing.T) {
	h := parseFixture(t, papertradeProtocolFixture)

	cur, prev, ok := h.lastComplete("volume")
	if !ok {
		t.Fatal("volume column should be usable")
	}
	// The last complete bucket is index 5, not 6: index 6 is still filling.
	wantCur, wantPrev := 741490668334.7, 564230133196.0
	if math.Abs(cur-wantCur) > 1 || math.Abs(prev-wantPrev) > 1 {
		t.Fatalf("got (%.1f, %.1f), want (%.1f, %.1f): the partial bucket was used",
			cur, prev, wantCur, wantPrev)
	}

	// And the delta those give is the last FULL day, which is what a 24h
	// metric must carry.
	day := cur - prev
	if math.Abs(day-177260535138.7) > 10 {
		t.Fatalf("daily delta %.0f is not the last full day", day)
	}
	// The naive reading (last two elements) is materially smaller, which is
	// precisely the understatement being guarded against.
	naive := 831948472533.0 - 741490668334.7
	if naive >= day {
		t.Fatalf("fixture no longer demonstrates the partial-bucket trap")
	}
}

func TestPapertradeLatestIsTheCurrentValue(t *testing.T) {
	h := parseFixture(t, papertradeProtocolFixture)
	// TVL is a level, not a counter, so the current value is the right read
	// even though the bucket is partial.
	tvl, ok := h.latest("tvl")
	if !ok || math.Abs(tvl-58716051.0) > 1 {
		t.Fatalf("latest tvl = %.1f, want 58716051", tvl)
	}
}

func TestPapertradeOpenInterestAddsAllFourSides(t *testing.T) {
	h := parseFixture(t, papertradeHouseFixture)

	var oi float64
	for _, side := range []string{"bl", "bs", "el", "es"} {
		v, ok := h.latest(side)
		if !ok {
			t.Fatalf("missing side %s", side)
		}
		oi += v
	}
	want := 181469913.9 + 107941992.6 + 91664310.6 + 66687413.8
	if math.Abs(oi-want) > 1 {
		t.Fatalf("oi = %.1f, want %.1f", oi, want)
	}
	// Every position faces the house rather than another trader, so halving
	// the sum the way an order book venue would is wrong here.
	if math.Abs(oi/2-want) < 1 {
		t.Fatal("open interest must not be halved on a house-counterparty venue")
	}
}

func TestPapertradeHouseEncodingParsesToo(t *testing.T) {
	h := parseFixture(t, papertradeHouseFixture)
	if h.BaseTimeMs == 0 || len(h.TimeOffsetsMs) != 5 {
		t.Fatalf("house time encoding not read: base=%d offsets=%d",
			h.BaseTimeMs, len(h.TimeOffsetsMs))
	}
	if h.StartMs != 0 {
		t.Fatal("house payload should not carry startMs")
	}
}

func TestPapertradeRejectsSeriesTooShortToHaveACompleteBucket(t *testing.T) {
	// A venue two buckets old cannot yield a full day, and publishing one
	// would be a part-day labelled 24h.
	h := &papertradeHistory{Columns: map[string][]float64{"volume": {0, 100}}}
	if _, _, ok := h.lastComplete("volume"); ok {
		t.Fatal("two buckets must not produce a 24h figure")
	}
	if _, _, ok := h.lastComplete("missing"); ok {
		t.Fatal("absent column must not be usable")
	}
}

func TestPapertradeStateGivesTheMarketCount(t *testing.T) {
	// Trimmed to the shape that matters: a list of per-instrument tuples.
	const raw = `{"instruments": [[0,"BTC",0,"10",true], [1,"ETH",1,"100",true]]}`
	var st papertradeState
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		t.Fatalf("state does not parse: %v", err)
	}
	if len(st.Instruments) != 2 {
		t.Fatalf("market count = %d, want 2", len(st.Instruments))
	}
}
