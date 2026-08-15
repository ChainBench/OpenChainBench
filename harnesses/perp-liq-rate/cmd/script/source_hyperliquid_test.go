package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func hlFillJSON(coin, px, sz string, ts int64, hash, tid string, liq any) string {
	liqStr := "null"
	if liq != nil {
		b, _ := json.Marshal(liq)
		liqStr = string(b)
	}
	return fmt.Sprintf(`{"coin":%q,"px":%q,"sz":%q,"time":%d,"hash":%q,"tid":%q,"liquidation":%s}`,
		coin, px, sz, ts, hash, tid, liqStr)
}

func TestHyperliquid_FetchLiquidationsSince_HappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["type"] == "userFillsByTime" {
			fmt.Fprintf(w, `[%s,%s,%s]`,
				hlFillJSON("ETH", "3000.0", "1.5", 1700000000000, "0xabc123", "1", map[string]any{"liq": true}),
				hlFillJSON("ETH", "3000.0", "2.0", 1700000001000, "0xdef456", "2", nil),
				hlFillJSON("ETH", "3100.0", "0.5", 1700000002000, "0xghi789", "3", map[string]any{"liq": true}),
			)
		}
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL}
	events, err := h.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	// 3000 * 1.5 = 4500
	if events[0].NotionalUSD != 4500.0 {
		t.Errorf("event[0] notional = %v, want 4500", events[0].NotionalUSD)
	}
	// 3100 * 0.5 = 1550
	if events[1].NotionalUSD != 1550.0 {
		t.Errorf("event[1] notional = %v, want 1550", events[1].NotionalUSD)
	}
}

func TestHyperliquid_FetchLiquidationsSince_CoinFilter(t *testing.T) {
	// Vault returns fills for multiple coins; only ETH should be kept.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `[%s,%s]`,
			hlFillJSON("ETH", "3000.0", "1.0", 1700000000000, "0xaaa", "1", map[string]any{"liq": true}),
			hlFillJSON("BTC", "60000.0", "0.1", 1700000001000, "0xbbb", "2", map[string]any{"liq": true}),
		)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL}
	events, err := h.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 ETH event, got %d", len(events))
	}
	if events[0].NotionalUSD != 3000.0 {
		t.Errorf("notional = %v, want 3000", events[0].NotionalUSD)
	}
}

func TestHyperliquid_FetchLiquidationsSince_SinceFilter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `[%s,%s,%s]`,
			hlFillJSON("ETH", "3000.0", "1.5", 1700000000000, "0xabc123", "1", map[string]any{"liq": true}),
			hlFillJSON("ETH", "3000.0", "2.0", 1700000001000, "0xdef456", "2", nil),
			hlFillJSON("ETH", "3100.0", "0.5", 1699990000000, "0xghi789", "3", map[string]any{"liq": true}),
		)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL}
	events, err := h.FetchLiquidationsSince("ETH", 1699999000000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event (older filtered), got %d", len(events))
	}
}

func TestHyperliquid_FetchLiquidationsSince_Server500(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL}
	_, err := h.FetchLiquidationsSince("ETH", 0)
	if err == nil {
		t.Fatal("expected error from 500, got nil")
	}
}

func TestHyperliquid_FetchLiquidationsSince_MalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `not json`)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL}
	_, err := h.FetchLiquidationsSince("ETH", 0)
	if err == nil {
		t.Fatal("expected decode error, got nil")
	}
}

func TestHyperliquid_FetchLiquidationsSince_ZeroHashFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `[%s]`,
			hlFillJSON("ETH", "3000.0", "1.0", 1700000000000,
				"0x0000000000000000000000000000000000000000000000000000000000000000",
				"99", map[string]any{"liq": true}),
		)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL}
	events, err := h.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Key != "tid:99" {
		t.Errorf("expected tid fallback key, got %q", events[0].Key)
	}
}

func TestHyperliquid_FetchOI_HappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["type"] == "metaAndAssetCtxs" {
			fmt.Fprint(w, `[
				{"universe":[{"name":"ETH"},{"name":"BTC"}]},
				[{"openInterest":"100.5","midPx":"3000.0","markPx":"3001.0"},{"openInterest":"5.0","midPx":"60000.0","markPx":"60001.0"}]
			]`)
		}
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL}
	oi, err := h.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 100.5 * 3000 = 301500
	if oi < 301499 || oi > 301501 {
		t.Errorf("OI = %v, want ~301500", oi)
	}
}

func TestHyperliquid_FetchOI_CoinNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `[
			{"universe":[{"name":"BTC"}]},
			[{"openInterest":"5.0","midPx":"60000.0","markPx":"60001.0"}]
		]`)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL}
	_, err := h.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error for missing coin, got nil")
	}
}

func TestHyperliquid_FetchLiquidationsSince_OxaHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/v1/hyperliquid/liquidations/") {
			fmt.Fprint(w, `{"data":[
				{"coin":"ETH","timestamp":"2026-08-14T12:59:09.333Z","price":"1872.3","size":"2.0","trade_id":12345},
				{"coin":"ETH","timestamp":"2026-08-14T13:00:00.000Z","price":"1900.0","size":"0.5","trade_id":99999}
			],"meta":{"next_cursor":null}}`)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL, archiveBaseURL: srv.URL, archiveAPIKey: "testkey"}
	events, err := h.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	// 1872.3 * 2.0 = 3744.6
	if events[0].NotionalUSD < 3744 || events[0].NotionalUSD > 3745 {
		t.Errorf("event[0] notional = %v, want ~3744.6", events[0].NotionalUSD)
	}
	if events[0].Key != "oxa:12345" {
		t.Errorf("event[0] key = %q, want oxa:12345", events[0].Key)
	}
	// 1900 * 0.5 = 950
	if events[1].NotionalUSD < 949 || events[1].NotionalUSD > 951 {
		t.Errorf("event[1] notional = %v, want ~950", events[1].NotionalUSD)
	}
}

func TestHyperliquid_FetchLiquidationsSince_OxaPagination(t *testing.T) {
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/v1/hyperliquid/liquidations/") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		callCount++
		if r.URL.Query().Get("cursor") == "" {
			fmt.Fprint(w, `{"data":[{"coin":"ETH","timestamp":"2026-08-14T12:00:00.000Z","price":"2000.0","size":"1.0","trade_id":1}],"meta":{"next_cursor":"abc"}}`)
		} else {
			fmt.Fprint(w, `{"data":[{"coin":"ETH","timestamp":"2026-08-14T13:00:00.000Z","price":"2000.0","size":"1.0","trade_id":2}],"meta":{"next_cursor":null}}`)
		}
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL, archiveBaseURL: srv.URL, archiveAPIKey: "testkey"}
	events, err := h.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events across 2 pages, got %d", len(events))
	}
	if callCount != 2 {
		t.Errorf("expected 2 API calls (2 pages), got %d", callCount)
	}
}

func TestHyperliquid_FetchLiquidationsSince_OxaError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL, archiveBaseURL: srv.URL, archiveAPIKey: "badkey"}
	_, err := h.FetchLiquidationsSince("ETH", 0)
	if err == nil {
		t.Fatal("expected error for 401, got nil")
	}
}

func TestHyperliquid_FetchLiquidationsSince_OxaFallsBackToVault(t *testing.T) {
	// No archiveAPIKey → uses vault userFillsByTime path
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `[%s]`,
			hlFillJSON("ETH", "3000.0", "1.0", 1700000000000, "0xabc", "1", map[string]any{"liq": true}),
		)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL, archiveBaseURL: srv.URL, archiveAPIKey: ""}
	events, err := h.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event from vault fallback, got %d", len(events))
	}
}

func TestHyperliquid_FetchOI_EmptyMidPxFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `[
			{"universe":[{"name":"ETH"}]},
			[{"openInterest":"10.0","midPx":"","markPx":"3001.0"}]
		]`)
	}))
	defer srv.Close()

	h := &Hyperliquid{infoURL: srv.URL}
	oi, err := h.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// markPx fallback: 10 * 3001 = 30010
	if oi < 30009 || oi > 30011 {
		t.Errorf("OI with markPx fallback = %v, want ~30010", oi)
	}
}
