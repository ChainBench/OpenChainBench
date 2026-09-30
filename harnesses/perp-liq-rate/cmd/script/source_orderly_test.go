package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Filtering by symbol returns whole liquidated accounts, and an account can
// hold legs on other markets. Only the matching leg may land on the row, and
// its notional is cost_position_transfer, already USD and signed.
func TestOrderly_FetchLiquidationsSince_OnlyMatchingLeg(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "liquidated_positions") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"rows": []map[string]any{
			{"liquidation_id": 101, "timestamp": 1790500000000, "positions_by_perp": []map[string]any{
				{"symbol": "PERP_ETH_USDC", "position_qty": "0.0914", "transfer_price": "2688.29", "cost_position_transfer": "245.709706"},
				{"symbol": "PERP_BTC_USDC", "position_qty": "-0.0146", "transfer_price": "84455.6", "cost_position_transfer": "-1233.05"},
			}},
			{"liquidation_id": 102, "timestamp": 1790500100000, "positions_by_perp": []map[string]any{
				{"symbol": "PERP_ETH_USDC", "position_qty": "-1.0559", "transfer_price": "2717.83", "cost_position_transfer": "-2869.76"},
			}},
		}}})
	}))
	defer srv.Close()

	o := &Orderly{baseURL: srv.URL}
	events, err := o.FetchLiquidationsSince("ETH", 1790400000000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2 ETH legs (the BTC leg of account 101 excluded)", len(events))
	}
	if events[0].NotionalUSD < 245.70 || events[0].NotionalUSD > 245.72 {
		t.Errorf("leg 1 notional = %v, want 245.71", events[0].NotionalUSD)
	}
	if events[1].NotionalUSD < 2869.75 || events[1].NotionalUSD > 2869.77 {
		t.Errorf("leg 2 notional = %v, want 2869.76 (sign dropped)", events[1].NotionalUSD)
	}
	if events[0].Key != "orderly:101:PERP_ETH_USDC" || events[1].Key != "orderly:102:PERP_ETH_USDC" {
		t.Errorf("keys = %q, %q", events[0].Key, events[1].Key)
	}
	if events[0].Bucket || events[0].Aggregate {
		t.Error("an Orderly row is one liquidation, not a bucket or an aggregate")
	}
}

func TestOrderly_FetchOIAndVolume(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/futures/PERP_ETH_USDC") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
			"open_interest": "12134.1438", "mark_price": "2691.88", "24h_amount": "11757840.0",
		}})
	}))
	defer srv.Close()

	o := &Orderly{baseURL: srv.URL}
	oi, err := o.FetchOI("ETH")
	if err != nil {
		t.Fatalf("FetchOI: %v", err)
	}
	want := 12134.1438 * 2691.88
	if oi < want*0.9999 || oi > want*1.0001 {
		t.Errorf("OI = %v, want %v", oi, want)
	}
	vol, err := o.FetchVolume24hUSD("ETH")
	if err != nil || vol != 11757840.0 {
		t.Errorf("volume = %v (%v), want 11757840 (24h_amount is already USD)", vol, err)
	}
	if _, err := o.FetchOI("DOGE"); err == nil {
		t.Error("expected an error for an unsupported asset")
	}
}
