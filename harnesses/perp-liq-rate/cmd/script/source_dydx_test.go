package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func makeDydxTrade(id, tradeType string) map[string]any {
	return map[string]any{
		"id":        id,
		"size":      "1.0",
		"price":     "3000.0",
		"type":      tradeType,
		"createdAt": "2023-11-15T00:00:00.000Z",
	}
}

func TestDydx_FetchLiquidationsSince_SinglePage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/trades/perpetualMarket/") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		trades := []map[string]any{
			makeDydxTrade("t1", "LIQUIDATED"),
			makeDydxTrade("t2", "TAKER"),
			makeDydxTrade("t3", "MAKER"),
		}
		resp := map[string]any{"trades": trades}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	d := &Dydx{baseURL: srv.URL}
	events, err := d.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 LIQUIDATED event, got %d", len(events))
	}
}

func TestDydx_FetchLiquidationsSince_Pagination(t *testing.T) {
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		var trades []map[string]any
		if callCount == 1 {
			// Full page: 100 TAKER trades + 1 LIQUIDATED at the start
			for i := 0; i < 99; i++ {
				trades = append(trades, map[string]any{
					"id":        fmt.Sprintf("taker-%d", i),
					"size":      "1.0",
					"price":     "3000.0",
					"type":      "TAKER",
					"createdAt": "2023-11-15T01:00:00.000Z",
				})
			}
			// One LIQUIDATED in the first page
			trades = append(trades, map[string]any{
				"id":        "liq-1",
				"size":      "2.0",
				"price":     "3000.0",
				"type":      "LIQUIDATED",
				"createdAt": "2023-11-15T01:00:01.000Z",
			})
		} else {
			// Second page: 5 trades, 1 LIQUIDATED
			for i := 0; i < 4; i++ {
				trades = append(trades, map[string]any{
					"id":        fmt.Sprintf("taker2-%d", i),
					"size":      "1.0",
					"price":     "3000.0",
					"type":      "TAKER",
					"createdAt": "2023-11-14T23:00:00.000Z",
				})
			}
			trades = append(trades, map[string]any{
				"id":        "liq-2",
				"size":      "1.5",
				"price":     "3000.0",
				"type":      "LIQUIDATED",
				"createdAt": "2023-11-14T23:00:01.000Z",
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"trades": trades})
	}))
	defer srv.Close()

	d := &Dydx{baseURL: srv.URL}
	events, err := d.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 LIQUIDATED events across pages, got %d", len(events))
	}
}

func TestDydx_FetchLiquidationsSince_NonLiquidatedFiltered(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trades := []map[string]any{
			makeDydxTrade("t1", "TAKER"),
			makeDydxTrade("t2", "MAKER"),
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"trades": trades})
	}))
	defer srv.Close()

	d := &Dydx{baseURL: srv.URL}
	events, err := d.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

func TestDydx_FetchLiquidationsSince_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	d := &Dydx{baseURL: srv.URL}
	_, err := d.FetchLiquidationsSince("ETH", 0)
	if err == nil {
		t.Fatal("expected error from 500, got nil")
	}
}

func TestDydx_FetchOI_HappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/perpetualMarkets" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		resp := map[string]any{
			"markets": map[string]any{
				"ETH-USD": map[string]any{
					"openInterest": "10.0",
					"oraclePrice":  "3000.0",
				},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	d := &Dydx{baseURL: srv.URL}
	oi, err := d.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 10 * 3000 = 30000
	if oi < 29999 || oi > 30001 {
		t.Errorf("OI = %v, want 30000", oi)
	}
}

func TestDydx_FetchOI_MarketNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"markets": map[string]any{
				"BTC-USD": map[string]any{"openInterest": "1.0", "oraclePrice": "60000.0"},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	d := &Dydx{baseURL: srv.URL}
	_, err := d.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error for missing market, got nil")
	}
}
