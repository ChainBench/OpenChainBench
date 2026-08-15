package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func makeParadexTrade(id string, ts int64, tradeType string) map[string]any {
	return map[string]any{
		"id":         id,
		"size":       "1.5",
		"price":      "3000.0",
		"created_at": ts,
		"trade_type": tradeType,
	}
}

func TestParadex_FetchLiquidationsSince_SinglePage(t *testing.T) {
	now := int64(1700000000000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"results": []map[string]any{
				makeParadexTrade("f1", now, "LIQUIDATION"),
				makeParadexTrade("f2", now+1000, "LIQUIDATION"),
				makeParadexTrade("f3", now+2000, "FILL"), // filtered out
			},
			"next": nil,
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	p := &Paradex{baseURL: srv.URL}
	events, err := p.FetchLiquidationsSince("ETH", now-1000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 LIQUIDATION events, got %d", len(events))
	}
	// 1.5 * 3000 = 4500
	if events[0].NotionalUSD < 4499 || events[0].NotionalUSD > 4501 {
		t.Errorf("notional = %v, want ~4500", events[0].NotionalUSD)
	}
}

func TestParadex_FetchLiquidationsSince_Pagination(t *testing.T) {
	now := int64(1700000000000)
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 1 {
			next := "tok2"
			resp := map[string]any{
				"results": []map[string]any{
					makeParadexTrade("f1", now, "LIQUIDATION"),
					makeParadexTrade("f2", now+1000, "LIQUIDATION"),
				},
				"next": &next,
			}
			_ = json.NewEncoder(w).Encode(resp)
			return
		}
		resp := map[string]any{
			"results": []map[string]any{
				makeParadexTrade("f3", now+2000, "LIQUIDATION"),
			},
			"next": nil,
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	p := &Paradex{baseURL: srv.URL}
	events, err := p.FetchLiquidationsSince("ETH", now-1000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events across 2 pages, got %d", len(events))
	}
	if callCount != 2 {
		t.Errorf("expected 2 server calls for pagination, got %d", callCount)
	}
}

func TestParadex_FetchLiquidationsSince_NonLiquidationFiltered(t *testing.T) {
	now := int64(1700000000000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"results": []map[string]any{
				makeParadexTrade("t1", now, "FILL"),
				makeParadexTrade("t2", now+1000, "FILL"),
			},
			"next": nil,
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	p := &Paradex{baseURL: srv.URL}
	events, err := p.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events (all FILL type), got %d", len(events))
	}
}

func TestParadex_FetchLiquidationsSince_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := &Paradex{baseURL: srv.URL}
	_, err := p.FetchLiquidationsSince("ETH", 0)
	if err == nil {
		t.Fatal("expected error from 500, got nil")
	}
}

func TestParadex_FetchOI_HappyPath(t *testing.T) {
	// open_interest is in base units (ETH); OI_USD = open_interest * mark_price
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"results": []map[string]any{
				{
					"open_interest": "25.0",    // 25 ETH
					"mark_price":    "3000.0",  // $3000/ETH
				},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	p := &Paradex{baseURL: srv.URL}
	oi, err := p.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 25 * 3000 = 75000
	if oi < 74999 || oi > 75001 {
		t.Errorf("OI = %v, want ~75000", oi)
	}
}

func TestParadex_FetchOI_ZeroMarkPriceFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"results": []map[string]any{
				{"open_interest": "25.0", "mark_price": "0"},
			},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	p := &Paradex{baseURL: srv.URL}
	_, err := p.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error for zero mark_price, got nil")
	}
}

func TestParadex_FetchOI_EmptyResults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"results": []map[string]any{},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	p := &Paradex{baseURL: srv.URL}
	_, err := p.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error for empty results, got nil")
	}
}
