package main

import (
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"
)

func TestKeccak256KnownVectors(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"},
		{"Transfer(address,address,uint256)", "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"},
		// > one rate block (136 bytes) to exercise multi-block absorption
		{strings.Repeat("a", 200), ""},
	}
	for _, c := range cases {
		h := keccak256([]byte(c.in))
		got := hex.EncodeToString(h[:])
		if c.want != "" && got != c.want {
			t.Fatalf("keccak256(%q) = %s, want %s", c.in, got, c.want)
		}
		t.Logf("keccak256(len=%d) = %s", len(c.in), got)
	}
}

func TestGainsTopicNonEmpty(t *testing.T) {
	if len(gainsLimitExecutedTopic) != 66 || !strings.HasPrefix(gainsLimitExecutedTopic, "0x") {
		t.Fatalf("bad topic %q", gainsLimitExecutedTopic)
	}
	t.Logf("LimitExecuted topic0 = %s", gainsLimitExecutedTopic)
}

func TestSlidingWindowAndSeenSet(t *testing.T) {
	w := NewSlidingWindow(24 * time.Hour)
	now := time.Now().UnixMilli()
	w.Add("stale", now-25*3600*1000, 100) // stale
	w.Add("a", now-3600*1000, 50)
	w.Add("b", now, 25)
	w.Prune(now)
	if got := w.Sum(); got != 75 {
		t.Fatalf("Sum = %v, want 75", got)
	}
	if w.Len() != 2 {
		t.Fatalf("Len = %d, want 2", w.Len())
	}
	// Collateral and leverage travel with the entries that carry them and
	// stay absent, not zero, for a window whose source exposes neither.
	if _, ok := w.SumCollateral(); ok {
		t.Fatal("a window of tape events reports collateral it does not have")
	}
	if _, ok := w.MedianLeverage(); ok {
		t.Fatal("a window of tape events reports a leverage it does not have")
	}
	w.AddEvent(LiqEvent{Key: "g1", TimestampMs: now, NotionalUSD: 1000, CollateralUSD: 10, Leverage: 100})
	w.AddEvent(LiqEvent{Key: "g2", TimestampMs: now, NotionalUSD: 500, CollateralUSD: 25, Leverage: 20})
	w.AddEvent(LiqEvent{Key: "g3", TimestampMs: now, NotionalUSD: 300, CollateralUSD: 6, Leverage: 50})
	if col, ok := w.SumCollateral(); !ok || col != 41 {
		t.Fatalf("SumCollateral = %v,%v want 41,true", col, ok)
	}
	if lev, ok := w.MedianLeverage(); !ok || lev != 50 {
		t.Fatalf("MedianLeverage = %v,%v want 50,true", lev, ok)
	}

	oi := NewSampleWindow(24 * time.Hour)
	oi.Add(now-3600*1000, 40)
	oi.Add(now, 10)
	// Time-weighted: 40 stood for the hour, 10 has only just arrived, so the
	// mean over the elapsed period is 40 and not the 25 an average of the two
	// readings would report.
	if got := oi.TimeWeightedMean(now); got < 39.9 || got > 40.1 {
		t.Fatalf("TimeWeightedMean = %v, want about 40", got)
	}
	if oi.Max() != 40 || oi.Min() != 10 || oi.Len() != 2 {
		t.Fatalf("SampleWindow max=%v min=%v len=%d, want 40, 10, 2", oi.Max(), oi.Min(), oi.Len())
	}

	s := NewSeenSet()
	if !s.Add("k1", now) || s.Add("k1", now) {
		t.Fatalf("SeenSet dedup broken")
	}
	s.Add("old", now-25*3600*1000)
	s.Prune(now - 24*3600*1000)
	if s.Len() != 1 {
		t.Fatalf("SeenSet prune broken, len=%d", s.Len())
	}
}

func TestParseScaled(t *testing.T) {
	v, err := parseScaled("1230000000000000000000000000000000", 30) // 1230 with 30 dp
	if err != nil || v < 1229.999 || v > 1230.001 {
		t.Fatalf("parseScaled 30dp = %v (%v)", v, err)
	}
	v, err = parseScaled("-2500000000000000000", 18)
	if err != nil || v != -2.5 {
		t.Fatalf("parseScaled negative = %v (%v)", v, err)
	}
}

// The retry backoff exists for the chain and the venues, not for the suite.
func TestMain(m *testing.M) {
	httpRetryBase = time.Millisecond
	gmxMarketsRetryBase = time.Millisecond
	os.Exit(m.Run())
}
