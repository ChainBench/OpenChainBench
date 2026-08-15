package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAevo_FetchLiquidationsSince_ReturnsEmpty(t *testing.T) {
	a := &Aevo{baseURL: "http://unused"}
	events, err := a.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

func TestAevo_FetchLiquidationsSince_UnknownAsset(t *testing.T) {
	a := &Aevo{baseURL: "http://unused"}
	_, err := a.FetchLiquidationsSince("SOL", 0)
	if err == nil {
		t.Fatal("expected error for unsupported asset, got nil")
	}
}

func TestAevo_FetchOI_HappyPath(t *testing.T) {
	// open_interest.total is in contract units; OI_USD = total * mark_price
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/statistics") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"open_interest": map[string]any{"total": "10.5"},
				"mark_price":    "3000.0",
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	a := &Aevo{baseURL: srv.URL}
	oi, err := a.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 10.5 * 3000 = 31500
	if oi < 31499 || oi > 31501 {
		t.Errorf("OI = %v, want ~31500", oi)
	}
}

func TestAevo_FetchOI_ZeroPriceFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"open_interest": map[string]any{"total": "10.5"},
			"mark_price":    "0",
		})
	}))
	defer srv.Close()

	a := &Aevo{baseURL: srv.URL}
	_, err := a.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error for zero mark_price, got nil")
	}
}

func TestAevo_FetchOI_UnknownAsset(t *testing.T) {
	a := &Aevo{baseURL: "http://unused"}
	_, err := a.FetchOI("SOL")
	if err == nil {
		t.Fatal("expected error for unsupported asset, got nil")
	}
}
