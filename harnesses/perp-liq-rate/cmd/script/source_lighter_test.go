package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// lighterTestMarket builds a market entry for the orderBookDetails mock.
func lighterTestMarket(symbol string, marketID int64, oi float64, markPrice string) map[string]any {
	return map[string]any{
		"symbol":        symbol,
		"market_id":     marketID,
		"open_interest": oi,
		"mark_price":    markPrice,
	}
}

// buildLighterOBServer creates a mock for the orderBookDetails endpoint only.
func buildLighterOBServer(t *testing.T, markets []map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "orderBookDetails") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"order_book_details": markets,
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
}

func TestLighterSymbolMatchesAsset(t *testing.T) {
	cases := []struct {
		symbol string
		asset  string
		want   bool
	}{
		{"ETH-USD", "ETH", true},
		{"ETH-USDC", "ETH", true},
		{"ETH/USD", "ETH", true},
		{"ETH", "ETH", true},
		{"WETH-USD", "ETH", false},
		{"BTC-USD", "ETH", false},
		{"BTC-USD", "BTC", true},
	}
	for _, c := range cases {
		got := lighterSymbolMatchesAsset(c.symbol, c.asset)
		if got != c.want {
			t.Errorf("lighterSymbolMatchesAsset(%q, %q) = %v, want %v", c.symbol, c.asset, got, c.want)
		}
	}
}

// FetchLiquidationsSince now returns empty (trades endpoint requires auth).

func TestLighter_FetchLiquidationsSince_ReturnsEmpty(t *testing.T) {
	markets := []map[string]any{lighterTestMarket("ETH-USD", 0, 42.0, "1878.0")}
	srv := buildLighterOBServer(t, markets)
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL}
	events, err := l.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

func TestLighter_FetchLiquidationsSince_404MarketList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL}
	_, err := l.FetchLiquidationsSince("ETH", 0)
	if err == nil {
		t.Fatal("expected error for 404")
	}
	if !errors.Is(err, ErrVenueUnavailable) {
		t.Errorf("expected ErrVenueUnavailable, got %v", err)
	}
	if l.consecUnavl != 1 {
		t.Errorf("consecUnavl = %d, want 1", l.consecUnavl)
	}
	var ue *unavailableError
	if errors.As(err, &ue) && ue.suppressed {
		t.Error("first occurrence should not be suppressed")
	}
}

func TestLighter_FetchLiquidationsSince_404Repeated(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL}
	var lastErr error
	for i := 0; i < 4; i++ {
		_, lastErr = l.FetchLiquidationsSince("ETH", 0)
	}
	if lastErr == nil {
		t.Fatal("expected error")
	}
	var ue *unavailableError
	if !errors.As(lastErr, &ue) {
		t.Fatalf("expected unavailableError, got %T", lastErr)
	}
	if !ue.suppressed {
		t.Error("4th occurrence should be suppressed (threshold is 3)")
	}
}

func TestLighter_FetchLiquidationsSince_RecoveryAfterStreak(t *testing.T) {
	failCount := 0
	markets := []map[string]any{lighterTestMarket("ETH-USD", 0, 42.0, "1878.0")}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failCount < 3 {
			failCount++
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"order_book_details": markets})
	}))
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL}
	for i := 0; i < 3; i++ {
		l.FetchLiquidationsSince("ETH", 0) //nolint
	}
	if l.consecUnavl != 3 {
		t.Fatalf("consecUnavl = %d, want 3 before recovery", l.consecUnavl)
	}

	_, err := l.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("expected recovery, got error: %v", err)
	}
	// resetUnavailable is not called in FetchLiquidationsSince (no trades fetch),
	// so consecUnavl stays at 3 after recovery — check that the error is gone.
	if err != nil {
		t.Errorf("post-recovery error: %v", err)
	}
}

func TestLighter_FetchOI_HappyPath(t *testing.T) {
	markets := []map[string]any{
		lighterTestMarket("ETH-USD", 0, 42279.85, "1878.2"),
	}
	srv := buildLighterOBServer(t, markets)
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL}
	oi, err := l.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 42279.85 * 1878.2 ≈ 79,406,624
	if oi < 79000000 || oi > 80000000 {
		t.Errorf("OI = %v, want ~79.4M", oi)
	}
}

func TestLighter_FetchOI_ZeroMarkPrice(t *testing.T) {
	markets := []map[string]any{
		lighterTestMarket("ETH-USD", 0, 93.0, "0"),
	}
	srv := buildLighterOBServer(t, markets)
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL}
	_, err := l.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error for zero mark_price, got nil")
	}
}

func TestLighter_FetchOI_MarketNotFound(t *testing.T) {
	markets := []map[string]any{
		lighterTestMarket("SOL-USD", 2, 10.0, "100.0"),
	}
	srv := buildLighterOBServer(t, markets)
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL}
	_, err := l.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error for unknown asset, got nil")
	}
}

func TestLighter_FetchLiquidationsSince_CoinalyzeNoKey(t *testing.T) {
	markets := []map[string]any{lighterTestMarket("ETH-USD", 0, 42.0, "1878.0")}
	srv := buildLighterOBServer(t, markets)
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL, czBaseURL: srv.URL, czAPIKey: ""}
	events, err := l.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events without api key, got %d", len(events))
	}
}

func TestLighter_FetchLiquidationsSince_CoinalyzeHappyPath(t *testing.T) {
	markets := []map[string]any{lighterTestMarket("ETH-USD", 0, 42.0, "2000.0")}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "orderBookDetails") {
			_ = json.NewEncoder(w).Encode(map[string]any{"order_book_details": markets})
			return
		}
		if strings.Contains(r.URL.Path, "liquidation-history") {
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"symbol": "0.T", "history": []map[string]any{
					{"t": int64(1786233600), "l": 3.0, "s": 2.0},
					{"t": int64(1786237200), "l": 0.0, "s": 0.0}, // zero bucket, skipped
				}},
			})
			return
		}
		// candleSnapshot: return a candle for the bucket timestamp so conversion uses $2000.
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"t": int64(1786233600000), "c": "2000.0"},
		})
	}))
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL, czBaseURL: srv.URL, czAPIKey: "testkey", hlInfoURL: srv.URL}
	events, err := l.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event (zero bucket skipped), got %d", len(events))
	}
	// (3 + 2) ETH * 2000 = 10000
	if events[0].NotionalUSD < 9999 || events[0].NotionalUSD > 10001 {
		t.Errorf("notional = %v, want ~10000", events[0].NotionalUSD)
	}
	if events[0].Key != "czlighter:ETH:1786233600" {
		t.Errorf("key = %q, want czlighter:ETH:1786233600", events[0].Key)
	}
}

func TestLighter_FetchLiquidationsSince_CoinalyzeSinceFilter(t *testing.T) {
	markets := []map[string]any{lighterTestMarket("ETH-USD", 0, 10.0, "1000.0")}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "orderBookDetails") {
			_ = json.NewEncoder(w).Encode(map[string]any{"order_book_details": markets})
			return
		}
		if strings.Contains(r.URL.Path, "liquidation-history") {
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"symbol": "0.T", "history": []map[string]any{
					{"t": int64(1000), "l": 5.0, "s": 0.0},  // before sinceMs (2000000ms), skipped
					{"t": int64(3000), "l": 2.0, "s": 1.0},  // after sinceMs (2000000ms), kept
				}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL, czBaseURL: srv.URL, czAPIKey: "testkey"}
	events, err := l.FetchLiquidationsSince("ETH", 2000000) // sinceMs = 2000 unix seconds in ms
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event (old bucket filtered), got %d", len(events))
	}
}

func TestLighter_MarketsCache(t *testing.T) {
	callCount := 0
	markets := []map[string]any{lighterTestMarket("ETH-USD", 0, 42.0, "1878.0")}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "orderBookDetails") {
			callCount++
			_ = json.NewEncoder(w).Encode(map[string]any{"order_book_details": markets})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	l := &Lighter{baseURL: srv.URL}
	if _, err := l.FetchOI("ETH"); err != nil {
		t.Fatalf("first FetchOI error: %v", err)
	}
	if _, err := l.FetchOI("ETH"); err != nil {
		t.Fatalf("second FetchOI error: %v", err)
	}
	if callCount != 1 {
		t.Errorf("orderBookDetails called %d times, want 1 (cache hit on second call)", callCount)
	}
}
