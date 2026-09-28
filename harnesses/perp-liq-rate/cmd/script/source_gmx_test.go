package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGmxAssetMatches(t *testing.T) {
	cases := []struct {
		name  string
		asset string
		want  bool
	}{
		{"ETH/USD [WETH-USDC]", "ETH", true},
		{"BTC/USD", "BTC", true},
		{"WETH/USD", "ETH", false},
		{"SOL/USD", "ETH", false},
		{"ETH-PERP", "ETH", true},
		{"ETH", "ETH", true},
		{"WETH", "ETH", false},
		{"ETH USD", "ETH", true},
	}
	for _, c := range cases {
		got := gmxAssetMatches(c.name, c.asset)
		if got != c.want {
			t.Errorf("gmxAssetMatches(%q, %q) = %v, want %v", c.name, c.asset, got, c.want)
		}
	}
}

func buildGMXInfoServer(t *testing.T, markets []map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"markets": markets})
	}))
}

func gmxMarketEntry(name, token string, isListed bool, oiLong, oiShort string) map[string]any {
	return map[string]any{
		"name":              name,
		"marketToken":       token,
		"isListed":          isListed,
		"openInterestLong":  oiLong,
		"openInterestShort": oiShort,
	}
}

// 5000 USD in 30-decimal: 5000 * 1e30
const gmxOI5000 = "5000000000000000000000000000000000"

// 3000 USD in 30-decimal
const gmxOI3000 = "3000000000000000000000000000000000"

func TestGMX_FetchOI_HappyPath(t *testing.T) {
	markets := []map[string]any{
		gmxMarketEntry("ETH/USD [ETH-USDC]", "0xETH1", true, gmxOI5000, gmxOI3000),
		gmxMarketEntry("ETH/USD [ETH-ETH]", "0xETH2", true, gmxOI5000, gmxOI5000),
		gmxMarketEntry("BTC/USD [WBTC-USDC]", "0xBTC1", true, gmxOI3000, gmxOI3000),
	}
	srv := buildGMXInfoServer(t, markets)
	defer srv.Close()

	g := &GMX{marketsURL: srv.URL}
	oi, err := g.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// ETH: (5000+3000) + (5000+5000) = 18000, long plus short across both
	// markets. A pool venue's two sides are independent, so both count.
	if oi < 17999 || oi > 18001 {
		t.Errorf("OI = %v, want ~18000 (long plus short)", oi)
	}
}

func TestGMX_FetchOI_SkipsUnlisted(t *testing.T) {
	markets := []map[string]any{
		gmxMarketEntry("ETH/USD [ETH-USDC]", "0xETH1", true, gmxOI5000, gmxOI3000),
		gmxMarketEntry("ETH/USD [ETH-synth]", "0xETH2", false, gmxOI5000, gmxOI5000), // unlisted
	}
	srv := buildGMXInfoServer(t, markets)
	defer srv.Close()

	g := &GMX{marketsURL: srv.URL}
	oi, err := g.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Only the listed market: 5000 + 3000 = 8000, long plus short.
	if oi < 7999 || oi > 8001 {
		t.Errorf("OI = %v, want ~8000 (unlisted market excluded)", oi)
	}
}

func TestGMX_FetchOI_NoMarketsForAsset(t *testing.T) {
	markets := []map[string]any{
		gmxMarketEntry("BTC/USD [WBTC-USDC]", "0xBTC1", true, gmxOI5000, gmxOI3000),
	}
	srv := buildGMXInfoServer(t, markets)
	defer srv.Close()

	g := &GMX{marketsURL: srv.URL}
	_, err := g.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error for asset with no listed markets, got nil")
	}
}

func TestGMX_FetchOI_MarketsFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	g := &GMX{marketsURL: srv.URL}
	_, err := g.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error when markets endpoint fails, got nil")
	}
}

func TestGMX_FetchOI_UnknownAsset(t *testing.T) {
	g := &GMX{marketsURL: "http://unused"}
	_, err := g.FetchOI("SOL")
	if err == nil {
		t.Fatal("expected error for unsupported asset, got nil")
	}
}

// The squid does have an order type, contrary to what this bench claimed
// until 2026-09-27: tradeActions.orderType is 7 for a liquidation, and
// sizeDeltaUsd is already USD at 30 decimals. The market a row belongs to is
// identified by the token before the first separator in the market name, so
// an XRP market collateralised in ETH must not land on the ETH row.
func TestGMX_FetchLiquidationsSince_DecodesSquidRows(t *testing.T) {
	markets := []map[string]any{
		gmxMarketEntry("ETH/USD [ETH-USDC]", "0xEthMarket", true, gmxOI5000, gmxOI3000),
		gmxMarketEntry("XRP/USD [ETH-USDC]", "0xXrpMarket", true, gmxOI5000, gmxOI3000),
	}
	var gotQuery string
	squid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Query string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotQuery = body.Query
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{"tradeActions": []map[string]any{
				// $276,827 on ETH, the figure measured on 2026-09-27.
				{"marketAddress": "0xEthMarket", "sizeDeltaUsd": "276827000000000000000000000000000000",
					"timestamp": 1790500000, "transactionHash": "0xaa", "orderKey": "0xkey1"},
				// An XRP market that happens to take ETH as collateral.
				{"marketAddress": "0xXrpMarket", "sizeDeltaUsd": "999000000000000000000000000000000000",
					"timestamp": 1790500001, "transactionHash": "0xbb", "orderKey": "0xkey2"},
				// A market the /markets/info snapshot does not know.
				{"marketAddress": "0xUnknown", "sizeDeltaUsd": "1000000000000000000000000000000000",
					"timestamp": 1790500002, "transactionHash": "0xcc", "orderKey": "0xkey3"},
			}},
		})
	}))
	defer squid.Close()
	info := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"markets": markets})
	}))
	defer info.Close()

	g := &GMX{marketsURL: info.URL, squidURL: squid.URL}
	events, err := g.FetchLiquidationsSince("ETH", 1790400000000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1 (ETH only)", len(events))
	}
	if events[0].NotionalUSD < 276826 || events[0].NotionalUSD > 276828 {
		t.Errorf("notional = %v, want 276827", events[0].NotionalUSD)
	}
	if events[0].Key != "gmx:0xkey1" {
		t.Errorf("key = %q, want gmx:0xkey1", events[0].Key)
	}
	if events[0].TimestampMs != 1790500000000 {
		t.Errorf("timestamp = %d, want ms", events[0].TimestampMs)
	}
	// Both filters have to be in the query: without eventName every
	// liquidation is counted twice, once created and once executed.
	if !strings.Contains(gotQuery, "orderType_eq:7") {
		t.Errorf("query does not pin orderType 7: %s", gotQuery)
	}
	if !strings.Contains(gotQuery, `eventName_eq:"OrderExecuted"`) {
		t.Errorf("query does not pin eventName, so liquidations double: %s", gotQuery)
	}
	if !strings.Contains(gotQuery, "timestamp_gte:1790400000") {
		t.Errorf("query does not pass sinceMs as seconds: %s", gotQuery)
	}
}

func TestGMX_FetchVolume24hUSD_SumsExecutedPositionOrders(t *testing.T) {
	var gotQuery string
	squid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Query string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotQuery = body.Query
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{"tradeActions": []map[string]any{
				{"marketAddress": "0xEthMarket", "sizeDeltaUsd": "2000000000000000000000000000000000000",
					"timestamp": 1790500000, "orderKey": "0xa"},
				{"marketAddress": "0xEthMarket", "sizeDeltaUsd": "1650000000000000000000000000000000000",
					"timestamp": 1790500001, "orderKey": "0xb"},
			}},
		})
	}))
	defer squid.Close()
	info := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"markets": []map[string]any{
			gmxMarketEntry("ETH/USD [ETH-USDC]", "0xEthMarket", true, gmxOI5000, gmxOI3000),
		}})
	}))
	defer info.Close()

	g := &GMX{marketsURL: info.URL, squidURL: squid.URL}
	v, err := g.FetchVolume24hUSD("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v < 3649999 || v > 3650001 {
		t.Fatalf("volume = %v, want 3650000", v)
	}
	// Swap order types 0 and 1 are not position notional.
	if !strings.Contains(gotQuery, "orderType_gte:2") {
		t.Errorf("volume query does not exclude swaps: %s", gotQuery)
	}
	// Second call inside the TTL must not re-page the squid.
	squid.Close()
	if again, err := g.FetchVolume24hUSD("ETH"); err != nil || again != v {
		t.Fatalf("cached volume = %v (%v), want %v from cache", again, err, v)
	}
}

func TestGMX_SquidErrorsSurface(t *testing.T) {
	squid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"errors": []map[string]any{{"message": "Cannot query field orderType"}},
		})
	}))
	defer squid.Close()
	info := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"markets": []map[string]any{
			gmxMarketEntry("ETH/USD [ETH-USDC]", "0xEthMarket", true, gmxOI5000, gmxOI3000),
		}})
	}))
	defer info.Close()

	g := &GMX{marketsURL: info.URL, squidURL: squid.URL}
	if _, err := g.FetchLiquidationsSince("ETH", 0); err == nil {
		t.Fatal("a GraphQL error must fail the tick, not read as zero liquidations")
	}
}

func TestGMX_FetchLiquidationsSince_UnknownAsset(t *testing.T) {
	g := &GMX{marketsURL: "http://unused", squidURL: "http://unused"}
	_, err := g.FetchLiquidationsSince("DOGE", 0)
	if err == nil {
		t.Fatal("expected error for unsupported asset, got nil")
	}
}

func TestGMX_MarketsCache(t *testing.T) {
	callCount := 0
	markets := []map[string]any{
		gmxMarketEntry("ETH/USD [ETH-USDC]", "0xETH1", true, gmxOI5000, gmxOI3000),
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		_ = json.NewEncoder(w).Encode(map[string]any{"markets": markets})
	}))
	defer srv.Close()

	g := &GMX{marketsURL: srv.URL}
	if _, err := g.FetchOI("ETH"); err != nil {
		t.Fatalf("first FetchOI error: %v", err)
	}
	if _, err := g.FetchOI("ETH"); err != nil {
		t.Fatalf("second FetchOI error: %v", err)
	}
	if callCount != 1 {
		t.Errorf("markets endpoint called %d times, want 1 (cache hit on second call)", callCount)
	}
}
