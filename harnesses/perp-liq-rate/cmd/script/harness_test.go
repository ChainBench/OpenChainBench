package main

import (
	"encoding/hex"
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
	if len(gainsTradeClosedTopic) != 66 || !strings.HasPrefix(gainsTradeClosedTopic, "0x") {
		t.Fatalf("bad topic %q", gainsTradeClosedTopic)
	}
	t.Logf("TradeClosed topic0 = %s", gainsTradeClosedTopic)
}

func TestSlidingWindowAndSeenSet(t *testing.T) {
	w := NewSlidingWindow(24 * time.Hour)
	now := time.Now().UnixMilli()
	w.Add(now-25*3600*1000, 100) // stale
	w.Add(now-3600*1000, 50)
	w.Add(now, 25)
	w.Prune(now)
	if got := w.Sum(); got != 75 {
		t.Fatalf("Sum = %v, want 75", got)
	}
	if w.Len() != 2 {
		t.Fatalf("Len = %d, want 2", w.Len())
	}
	if w.IsWarm(time.Now()) {
		t.Fatalf("window should not be warm before MarkTick+span")
	}
	w.MarkTick(time.Now().Add(-25 * time.Hour))
	if !w.IsWarm(time.Now()) {
		t.Fatalf("window should be warm 25h after first tick")
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
