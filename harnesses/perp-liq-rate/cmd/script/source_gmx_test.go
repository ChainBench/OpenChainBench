package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	// ETH: (5000+3000) + (5000+5000) = 18000
	if oi < 17999 || oi > 18001 {
		t.Errorf("OI = %v, want ~18000", oi)
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
	// Only the listed market: 5000 + 3000 = 8000
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

func TestGMX_FetchLiquidationsSince_ReturnsEmpty(t *testing.T) {
	g := &GMX{marketsURL: "http://unused"}
	events, err := g.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events (no liquidation source), got %d", len(events))
	}
}

func TestGMX_FetchLiquidationsSince_UnknownAsset(t *testing.T) {
	g := &GMX{marketsURL: "http://unused"}
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
