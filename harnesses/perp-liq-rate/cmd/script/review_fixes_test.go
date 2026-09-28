package main

// review_fixes_test.go: the three things the 2026-09-28 review found, each
// pinned so it cannot come back.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A pool venue's open interest is long plus short. Halving it made the rate
// exceed 100% with no turnover at all whenever the book was unbalanced,
// which is the review's Major 2: 30M of longs against 10M of shorts
// published a 20M denominator, and a crash closing 25M of those longs read
// 125% against a book that was never smaller than the positions it held.
func TestPoolOpenInterestIsNotHalved(t *testing.T) {
	const long, short = 30e6, 10e6
	oi := poolOpenInterest(long, short)
	if oi != 40e6 {
		t.Fatalf("poolOpenInterest(30M, 10M) = %v, want 40M", oi)
	}
	liquidated := 25e6 // a crash takes most of the long book
	if rate := liquidated / oi * 100; rate > 100 {
		t.Fatalf("rate = %.1f%%, want at or under 100%% for a subset of the book", rate)
	}
	if halved := liquidated / ((long + short) / 2) * 100; halved <= 100 {
		t.Fatalf("the halved denominator should be the artifact this replaces, got %.1f%%", halved)
	}
	// Both sides can be liquidated on one volatile day, and the sum of both
	// still cannot exceed the book that held them.
	if rate := (25e6 + 8e6) / oi * 100; rate > 100 {
		t.Fatalf("both sides liquidated reads %.1f%%, want at or under 100%%", rate)
	}
}

// The open-interest window prunes every tick, not only when a reading lands.
// An endpoint failing for more than a day would otherwise leave the peak and
// the mean describing a book from before the outage.
func TestSampleWindowPrunesWithoutAdd(t *testing.T) {
	s := NewSampleWindow(24 * time.Hour)
	now := time.Now().UnixMilli()
	s.Add(now-23*3600*1000, 40e6)
	if s.Len() != 1 || s.Max() != 40e6 {
		t.Fatalf("len=%d max=%v after the reading", s.Len(), s.Max())
	}
	// Two days later, with no successful read in between.
	s.Prune(now + 25*3600*1000)
	if s.Len() != 0 || s.Max() != 0 || s.Mean() != 0 {
		t.Fatalf("len=%d max=%v mean=%v, want the stale reading dropped", s.Len(), s.Max(), s.Mean())
	}
}

// gmxVolumeStub answers markets/info and counts squid queries, returning the
// where clause of each so the market filter can be asserted.
func gmxVolumeStub(t *testing.T, rowsPerPage int) (*GMX, *[]string, func()) {
	t.Helper()
	markets := []map[string]any{
		gmxMarketEntry("ETH/USD [ETH-USDC]", "0xeth1", true, gmxOI5000, gmxOI3000),
		gmxMarketEntry("BTC/USD [WBTC-USDC]", "0xbtc1", true, gmxOI3000, gmxOI3000),
		gmxMarketEntry("DOGE/USD [ETH-USDC]", "0xdoge", true, gmxOI5000, gmxOI5000),
	}
	info := buildGMXInfoServer(t, markets)
	var queries []string
	squid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Query string `json:"query"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		queries = append(queries, body.Query)
		rows := make([]map[string]any, 0, rowsPerPage)
		for i := 0; i < rowsPerPage; i++ {
			rows = append(rows, map[string]any{
				"marketAddress": "0xeth1", "sizeDeltaUsd": "1" + strings.Repeat("0", 30),
				"timestamp": time.Now().Unix(), "transactionHash": "0xtx",
				"orderKey": fmt.Sprintf("k%d-%d", len(queries), i),
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{"tradeActions": rows},
		})
	}))
	g := &GMX{marketsURL: info.URL, squidURL: squid.URL}
	return g, &queries, func() { info.Close(); squid.Close() }
}

// The volume query names the tracked markets. Asking for every market put a
// normal day a small multiple under the page cap, so a busy day refused the
// sum and unranked GMX: the review's Major 1.
func TestGMXVolumeQueryFiltersToTrackedMarkets(t *testing.T) {
	g, queries, done := gmxVolumeStub(t, 1)
	defer done()

	if _, err := g.FetchVolume24hUSD("ETH"); err != nil {
		t.Fatalf("volume: %v", err)
	}
	if len(*queries) == 0 {
		t.Fatal("no squid query was sent")
	}
	q := (*queries)[0]
	if !strings.Contains(q, "marketAddress_in") {
		t.Fatalf("query has no market filter: %s", q)
	}
	if !strings.Contains(q, `"0xeth1"`) || !strings.Contains(q, `"0xbtc1"`) {
		t.Fatalf("query omits a tracked market: %s", q)
	}
	if strings.Contains(q, "0xdoge") {
		t.Fatalf("query asks for an untracked market: %s", q)
	}
}

// The filter carries both spellings of each address. marketAddress_in is an
// exact string match, the squid stores EIP-55 checksummed addresses and the
// market map is keyed lowercase, so sending one spelling matched nothing and
// left both GMX rows with no volume denominator at all.
func TestGMXVolumeQueryCarriesBothAddressCasings(t *testing.T) {
	markets := []map[string]any{
		gmxMarketEntry("ETH/USD [ETH-USDC]", "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336", true, gmxOI5000, gmxOI3000),
	}
	info := buildGMXInfoServer(t, markets)
	defer info.Close()
	var query string
	squid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Query string `json:"query"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		query = body.Query
		// The squid answers on the checksummed spelling only.
		rows := []map[string]any{}
		if strings.Contains(body.Query, `"0x70d95587d40A2caf56bd97485aB3Eec10Bee6336"`) {
			rows = append(rows, map[string]any{
				"marketAddress": "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
				"sizeDeltaUsd":  "5" + strings.Repeat("0", 30),
				"timestamp":     time.Now().Unix(), "transactionHash": "0xtx", "orderKey": "k1",
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"tradeActions": rows}})
	}))
	defer squid.Close()

	g := &GMX{marketsURL: info.URL, squidURL: squid.URL}
	vol, err := g.FetchVolume24hUSD("ETH")
	if err != nil {
		t.Fatalf("volume: %v", err)
	}
	if vol <= 0 {
		t.Fatalf("volume = %v with a checksummed squid; the filter lost the market: %s", vol, query)
	}
	if !strings.Contains(query, strings.ToLower("0x70d95587d40A2caf56bd97485aB3Eec10Bee6336")) {
		t.Errorf("query carries no lowercase spelling: %s", query)
	}
}

// A failed refresh is cached for the TTL. Only success wrote the cache
// before, so the ETH goroutine and then the BTC goroutine each paged the
// squid to the cap on every tick.
func TestGMXVolumeCachesTheFailure(t *testing.T) {
	// Every page comes back full, so paging runs to the cap and refuses.
	g, queries, done := gmxVolumeStub(t, gmxSquidPageLimit)
	defer done()

	if _, err := g.FetchVolume24hUSD("ETH"); err == nil {
		t.Fatal("a page-cap refusal must not read as a volume")
	}
	afterFirst := len(*queries)
	if afterFirst != gmxSquidMaxPages {
		t.Fatalf("first read sent %d queries, want the cap of %d", afterFirst, gmxSquidMaxPages)
	}
	if _, err := g.FetchVolume24hUSD("BTC"); err == nil {
		t.Fatal("the cached failure must still be an error")
	}
	if len(*queries) != afterFirst {
		t.Fatalf("the second asset re-paged the squid: %d queries, want %d", len(*queries), afterFirst)
	}
}
