package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func asterStubs(t *testing.T, buckets []map[string]any) (*Aster, func()) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "ticker/24hr"):
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"symbol": "ETHUSDT", "lastPrice": "2687.70", "quoteVolume": "123497828.0"},
				{"symbol": "BTCUSDT", "lastPrice": "84402.00", "quoteVolume": "188667186.0"},
			})
		case strings.Contains(r.URL.Path, "openInterest"):
			_ = json.NewEncoder(w).Encode(map[string]any{"openInterest": "101632.258"})
		case strings.Contains(r.URL.Path, "liquidation-history"):
			_ = json.NewEncoder(w).Encode([]map[string]any{{"symbol": "ETHUSDT.S", "history": buckets}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	a := &Aster{baseURL: srv.URL, czBaseURL: srv.URL, czAPIKey: "testkey", hlInfoURL: srv.URL}
	return a, srv.Close
}

// Coinalyze reports Aster's buckets in base-asset units, so they need a price.
// 6.594 long plus 76.093 short at the 2687.70 fallback is about $222k, which
// is the order of the $224,246 measured on 2026-09-27.
func TestAster_FetchLiquidationsSince_ConvertsBaseUnits(t *testing.T) {
	a, done := asterStubs(t, []map[string]any{
		{"t": int64(1790496000), "l": 6.594, "s": 76.093},
		{"t": int64(1790499600), "l": 0.0, "s": 0.0},
	})
	defer done()

	events, err := a.FetchLiquidationsSince("ETH", 1790499000000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1 (the empty hour is skipped)", len(events))
	}
	if !events[0].Bucket {
		t.Error("an hourly bucket must be marked for restatement, or it freezes at its first reading")
	}
	want := (6.594 + 76.093) * 2687.70
	if events[0].NotionalUSD < want*0.999 || events[0].NotionalUSD > want*1.001 {
		t.Errorf("notional = %v, want about %v", events[0].NotionalUSD, want)
	}
	if events[0].Key != "czaster:ETH:1790496000" {
		t.Errorf("key = %q", events[0].Key)
	}
}

func TestAster_FetchOIAndVolume(t *testing.T) {
	a, done := asterStubs(t, nil)
	defer done()

	oi, err := a.FetchOI("ETH")
	if err != nil {
		t.Fatalf("FetchOI: %v", err)
	}
	want := 101632.258 * 2687.70
	if oi < want*0.999 || oi > want*1.001 {
		t.Errorf("OI = %v, want about %v", oi, want)
	}

	vol, err := a.FetchVolume24hUSD("ETH")
	if err != nil {
		t.Fatalf("FetchVolume24hUSD: %v", err)
	}
	if vol != 123497828.0 {
		t.Errorf("volume = %v, want 123497828 (quoteVolume is already USD)", vol)
	}
}

func TestAster_NoCoinalyzeKeyYieldsNoEvents(t *testing.T) {
	a, done := asterStubs(t, []map[string]any{{"t": int64(1790496000), "l": 1.0, "s": 1.0}})
	defer done()
	a.czAPIKey = ""
	events, err := a.FetchLiquidationsSince("ETH", 0)
	if err != nil || len(events) != 0 {
		t.Fatalf("got %d events (%v), want none without a key", len(events), err)
	}
}

func TestAster_UnsupportedAsset(t *testing.T) {
	a := NewAster()
	for _, fn := range []func(string) (float64, error){a.FetchOI, a.FetchVolume24hUSD} {
		if _, err := fn("DOGE"); err == nil {
			t.Error("expected an error for an unsupported asset")
		}
	}
	if _, err := a.FetchLiquidationsSince("DOGE", 0); err == nil {
		t.Error("expected an error for an unsupported asset")
	}
}
