package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ostiumStub answers whichever of the three queries it is handed.
func ostiumStub(t *testing.T, tradeEvents, pairs, orders []map[string]any) (*Ostium, *[]string, func()) {
	t.Helper()
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct{ Query string }
		_ = json.Unmarshal(body, &req)
		seen = append(seen, req.Query)
		data := map[string]any{}
		switch {
		case strings.Contains(req.Query, "tradeEvents"):
			data["tradeEvents"] = tradeEvents
		case strings.Contains(req.Query, "pairs"):
			data["pairs"] = pairs
		case strings.Contains(req.Query, "orders"):
			data["orders"] = orders
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	}))
	return &Ostium{subgraphURL: srv.URL}, &seen, srv.Close
}

// The size has to come off the linked trade: tradeEvents.notional is null on
// a liquidation row, so reading it there yields nothing at all.
func TestOstium_FetchLiquidationsSince_ReadsNotionalFromTrade(t *testing.T) {
	o, seen, done := ostiumStub(t, []map[string]any{
		{"id": "ev1", "timestamp": "1790500000",
			"pair":  map[string]any{"from": "ETH"},
			"trade": map[string]any{"notional": "7987246575"}}, // $7,987.25
		{"id": "ev2", "timestamp": "1790500100",
			"pair":  map[string]any{"from": "ADA"},
			"trade": map[string]any{"notional": "1000000000"}},
		{"id": "ev3", "timestamp": "1790500200",
			"pair":  map[string]any{"from": "ETH"},
			"trade": map[string]any{"notional": "0"}}, // no size, skipped
	}, nil, nil)
	defer done()

	events, err := o.FetchLiquidationsSince("ETH", 1790400000000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1 (ETH, non-zero)", len(events))
	}
	if events[0].NotionalUSD < 7987.24 || events[0].NotionalUSD > 7987.26 {
		t.Errorf("notional = %v, want 7987.25 (6-decimal USD)", events[0].NotionalUSD)
	}
	if events[0].TimestampMs != 1790500000000 {
		t.Errorf("timestamp = %d, want seconds promoted to ms", events[0].TimestampMs)
	}
	if events[0].Key != "ostium:ev1" {
		t.Errorf("key = %q", events[0].Key)
	}
	if !strings.Contains((*seen)[0], "type:LiquidationExecuted") {
		t.Errorf("query does not pin the liquidation event type: %s", (*seen)[0])
	}
}

func TestOstium_FetchOI_SumsBothSidesAtPrice(t *testing.T) {
	o, _, done := ostiumStub(t, nil, []map[string]any{
		{"from": "ETH",
			"longOI":         "16262800000000000000",    // 16.2628 ETH
			"shortOI":        "12717600000000000000",    // 12.7176 ETH
			"lastTradePrice": "2690300000000000000000"}, // $2690.30
		{"from": "BTC", "longOI": "1", "shortOI": "1", "lastTradePrice": "1"},
	}, nil)
	defer done()

	oi, err := o.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := (16.2628 + 12.7176) * 2690.30 // long plus short
	if oi < want*0.9999 || oi > want*1.0001 {
		t.Errorf("OI = %v, want about %v", oi, want)
	}

	if _, err := o.FetchOI("SOL"); err == nil {
		t.Error("expected an error when the pair is absent from the subgraph")
	}
}

// The subgraph's boolean filters do not work, so cancelled and failed orders
// have to be dropped here or the volume denominator is overstated.
func TestOstium_FetchVolume24hUSD_DropsCancelledAndFailed(t *testing.T) {
	o, seen, done := ostiumStub(t, nil, nil, []map[string]any{
		{"notional": "49902000000", "isCancelled": false, "isFailed": false,
			"pair": map[string]any{"from": "ETH"}},
		{"notional": "10000000000", "isCancelled": true, "isFailed": false,
			"pair": map[string]any{"from": "ETH"}},
		{"notional": "10000000000", "isCancelled": false, "isFailed": true,
			"pair": map[string]any{"from": "ETH"}},
		{"notional": "67050000000", "isCancelled": false, "isFailed": false,
			"pair": map[string]any{"from": "BTC"}},
	})
	defer done()

	vol, err := o.FetchVolume24hUSD("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if vol < 49901 || vol > 49903 {
		t.Errorf("volume = %v, want 49902", vol)
	}
	if strings.Contains((*seen)[0], "isCancelled:") {
		t.Errorf("the where clause names a boolean, which returns no rows at all: %s", (*seen)[0])
	}
}

func TestOstium_GraphQLErrorFailsTheTick(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"errors": []map[string]any{{"message": "Unknown enum value"}},
		})
	}))
	defer srv.Close()
	o := &Ostium{subgraphURL: srv.URL}
	if _, err := o.FetchLiquidationsSince("ETH", 0); err == nil {
		t.Fatal("a GraphQL error must fail the tick rather than read as zero liquidations")
	}
}
