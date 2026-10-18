package main

import (
	"net/url"
	"strings"
	"testing"
)

// marketsURLLen rebuilds the request fetchMarkets sends for one batch and
// returns its full length, the quantity CoinGecko actually refuses on.
func marketsURLLen(ids []string) int {
	q := url.Values{}
	q.Set("vs_currency", "usd")
	q.Set("ids", strings.Join(ids, ","))
	q.Set("per_page", "250")
	q.Set("price_change_percentage", "30d")
	return len(cgMarkets + "?" + q.Encode())
}

func slugs(n, width int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = strings.Repeat("x", width)
	}
	return out
}

// The bug this guards: CoinGecko answers 403 (not 429) once the query
// string gets long, and the retry path only covers 429, so one oversized
// call killed the sweep for 5.6 days. Measured from the probe host on
// 2026-10-04: 136 chars -> 200, 547 -> 200, 2,307 -> 403. The true limit
// is somewhere between 547 and 2,307 and was not narrowed, so the ceiling
// is set near the safe end rather than the unknown middle.
const marketsURLCeiling = 1200

func TestMarketsBatchKeepsURLShort(t *testing.T) {
	// A generous slug width: CoinGecko ids are usually under 20 characters
	// ("curve-dao-token" is 15, "pancakeswap-token" 17), so 20 is already
	// above the cohort and leaves the batch real headroom.
	if got := marketsURLLen(slugs(cgMarketsBatch, 20)); got > marketsURLCeiling {
		t.Errorf("a full batch builds a %d-character URL, over the %d ceiling: CoinGecko 403s long queries and the handler does not retry those", got, marketsURLCeiling)
	}
}

func TestOldBatchSizeWouldHaveBeenRefused(t *testing.T) {
	// Pins the regression itself rather than only its fix: the previous
	// batch of 250 is exactly what produced the 2,307-character URL the
	// probe host got a 403 on.
	if got := marketsURLLen(slugs(250, 24)); got <= marketsURLCeiling {
		t.Fatalf("expected the old batch of 250 to exceed the ceiling, got %d: the ceiling no longer describes the failure", got)
	}
}

func TestBatchCoversTheCohortWithoutLosingItsTail(t *testing.T) {
	// 152 protocols on 2026-10-04. Walk the same loop fetchMarkets walks
	// and check every id is requested exactly once.
	ids := make([]string, 152)
	for i := range ids {
		ids[i] = string(rune('a'+i%26)) + strings.Repeat("y", i%7)
	}
	seen := map[string]int{}
	calls := 0
	for i := 0; i < len(ids); i += cgMarketsBatch {
		end := i + cgMarketsBatch
		if end > len(ids) {
			end = len(ids)
		}
		calls++
		for _, id := range ids[i:end] {
			seen[id]++
		}
	}
	if calls != 4 {
		t.Errorf("152 ids at a batch of %d = %d calls, want 4", cgMarketsBatch, calls)
	}
	for _, id := range ids {
		if seen[id] != 1 {
			t.Fatalf("id %q requested %d times, want exactly 1", id, seen[id])
		}
	}
}
