package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A snapshot pair with x18 counters. The 24h liquidated figure is the
// difference, and it is handed to the window as one Aggregate entry.
func nadoStub(t *testing.T) (*Nado, *[]string, func()) {
	t.Helper()
	var posts []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "symbols") {
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"type": "perp", "product_id": 2, "symbol": "BTC-PERP"},
				{"type": "perp", "product_id": 4, "symbol": "ETH-PERP"},
				{"type": "spot", "product_id": 3, "symbol": "ETH"},
			})
			return
		}
		body, _ := io.ReadAll(r.Body)
		posts = append(posts, string(body))
		_ = json.NewEncoder(w).Encode(map[string]any{"snapshots": []map[string]any{
			{"timestamp": 1790531547,
				"cumulative_liquidation_amounts": map[string]string{"2": "78757933190000000000000000", "4": "500000000000000000000"},
				"cumulative_volumes":             map[string]string{"2": "9054641070000000000000000000", "4": "3041664934000000000000000000"},
				"open_interests":                 map[string]string{"2": "19614691000000000000000000", "4": "15116580000000000000000000"}},
			{"timestamp": 1790445599,
				"cumulative_liquidation_amounts": map[string]string{"2": "78731900000000000000000000", "4": "500000000000000000000"},
				"cumulative_volumes":             map[string]string{"2": "9000000000000000000000000000", "4": "3000000000000000000000000000"},
				"open_interests":                 map[string]string{"2": "1", "4": "1"}},
		}})
	}))
	return &Nado{archiveURL: srv.URL, symbolsURL: srv.URL + "/symbols"}, &posts, srv.Close
}

func TestNado_WindowDeltasAreAggregates(t *testing.T) {
	n, posts, done := nadoStub(t)
	defer done()

	events, err := n.FetchLiquidationsSince("BTC", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want exactly one aggregate", len(events))
	}
	e := events[0]
	// (78757933.19 - 78731900.00) x18 = 26,033.19 USD
	if e.NotionalUSD < 26033.18 || e.NotionalUSD > 26033.20 {
		t.Errorf("liquidated = %v, want 26033.19", e.NotionalUSD)
	}
	if !e.Bucket || !e.Aggregate {
		t.Error("the Nado window figure must be both restatable and marked Aggregate")
	}
	if e.Key != "nado:BTC:window" {
		t.Errorf("key = %q", e.Key)
	}

	// No liquidation in the window on ETH: no event, not a zero event.
	ethEvents, err := n.FetchLiquidationsSince("ETH", 0)
	if err != nil || len(ethEvents) != 0 {
		t.Fatalf("ETH: got %d events (%v), want none", len(ethEvents), err)
	}

	// The product ids come from the catalog, only perps, only tracked assets.
	if !strings.Contains((*posts)[0], `"product_ids":[`) {
		t.Errorf("snapshot request does not pin product ids: %s", (*posts)[0])
	}
	if strings.Contains((*posts)[0], "3") && !strings.Contains((*posts)[0], "[2,4]") && !strings.Contains((*posts)[0], "[4,2]") {
		t.Errorf("spot product leaked into the perp request: %s", (*posts)[0])
	}
}

func TestNado_OIAndVolumeFromTheSamePair(t *testing.T) {
	n, _, done := nadoStub(t)
	defer done()

	oi, err := n.FetchOI("BTC")
	if err != nil {
		t.Fatalf("FetchOI: %v", err)
	}
	if oi < 19614690 || oi > 19614692 {
		t.Errorf("OI = %v, want 19614691 (x18 USD, newest snapshot)", oi)
	}
	vol, err := n.FetchVolume24hUSD("BTC")
	if err != nil {
		t.Fatalf("FetchVolume24hUSD: %v", err)
	}
	if vol < 54641069 || vol > 54641071 {
		t.Errorf("volume = %v, want 54641070 (delta of cumulative_volumes)", vol)
	}
}

// A cumulative counter that reads lower in the newer snapshot is a source
// fault, not a negative liquidation. The delta clamps to zero.
func TestX18Delta(t *testing.T) {
	if got := x18Delta("2000000000000000000", "1500000000000000000"); got != 0.5 {
		t.Errorf("delta = %v, want 0.5", got)
	}
	if got := x18Delta("1000000000000000000", "1500000000000000000"); got != 0 {
		t.Errorf("negative delta = %v, want 0", got)
	}
	if got := x18Delta("x", "1"); got != 0 {
		t.Errorf("unparsable = %v, want 0", got)
	}
}
