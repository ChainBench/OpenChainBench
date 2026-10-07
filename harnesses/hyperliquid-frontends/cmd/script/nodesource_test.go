package main

import (
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// serveReducer stands in for hl-fills-reduce on the node box.
func serveReducer(t *testing.T, index []nodeDayIndex, days map[string]nodeDay) *NodeSource {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/days", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(index)
	})
	mux.HandleFunc("/daily/", func(w http.ResponseWriter, r *http.Request) {
		d, ok := days[r.URL.Path[len("/daily/"):]]
		if !ok {
			http.Error(w, "no", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		zw := gzip.NewWriter(w)
		defer zw.Close()
		_ = json.NewEncoder(zw).Encode(d)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	n := &NodeSource{
		BaseURL: srv.URL,
		Client:  &http.Client{Timeout: 5 * time.Second},
		index:   map[string]nodeDayIndex{},
		days:    map[string]*nodeDay{},
	}
	if err := n.Refresh(); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	return n
}

func wholeDay(day string, builders map[string]*nodeTotals) nodeDay {
	return nodeDay{Schema: nodeSchema, Day: day, Hours: 24, Complete: true, Builders: builders}
}

// The figures are fomo's real ones for 2026-10-06, where the public export
// carried $53.1M and $25,288 of the day's $192.5M and $93,131.
func TestNodeSourceServesAWholeDay(t *testing.T) {
	const addr = "0x2a2b6b093a9813fbd8cddae800c3d17d46460d17"
	n := serveReducer(t,
		[]nodeDayIndex{{Day: "20261006", Hours: 24, Complete: true}},
		map[string]nodeDay{"20261006": wholeDay("20261006", map[string]*nodeTotals{
			addr: {
				VolumeUSD: 192_499_360, FeesUSD: 93_131.22, Fills: 53_017, Taker: 51_273,
				LastFill: 1791331183,
				CoinVol:  map[string]float64{"BTC": 84_086_270},
				Users: map[string]*nodeUserAgg{
					"0xaaa": {Vol: 100, Pnl: 5, Fee: 1, Fills: 2},
				},
			},
		})})

	s := n.Summary([]string{addr}, "20261006")
	if s == nil {
		t.Fatal("no summary for a day the node has whole")
	}
	if s.vol != 192_499_360 || s.fees != 93_131.22 {
		t.Fatalf("got vol %v fees %v", s.vol, s.fees)
	}
	if s.taker != 51_273 || s.fills != 53_017 {
		t.Fatalf("got taker %v fills %v", s.taker, s.fills)
	}
	if len(s.users) != 1 || s.users["0xaaa"].vol != 100 {
		t.Fatalf("users did not carry through: %v", s.users)
	}
	// The address is matched case-insensitively, because a registry entry is
	// not guaranteed to be lowercased and the reducer always lowercases.
	if up := n.Summary([]string{"0x2A2B6B093A9813FBD8CDDAE800C3D17D46460D17"}, "20261006"); up == nil {
		t.Fatal("uppercase address did not match")
	}
}

// A day the node only half covered is not a smaller reading of that day, it
// is a fraction of one, and the mirror may hold the hours the node missed.
// Falling through is the only safe answer; serving the fraction would look
// exactly like the bug this source exists to fix.
func TestNodeSourceDeclinesAPartialDay(t *testing.T) {
	const addr = "0xabc"
	n := serveReducer(t,
		[]nodeDayIndex{{Day: "20261003", Hours: 10, Complete: false}},
		map[string]nodeDay{"20261003": {
			Schema: nodeSchema, Day: "20261003", Hours: 10, Complete: false,
			Builders: map[string]*nodeTotals{addr: {VolumeUSD: 1, FeesUSD: 1, Fills: 1}},
		}})
	if s := n.Summary([]string{addr}, "20261003"); s != nil {
		t.Fatalf("a 10-hour day was served as if whole: %+v", s)
	}
	if n.WholeDays()["20261003"] {
		t.Fatal("a partial day counted as whole")
	}
}

// A day written under a shape this build does not know would decode into
// zeros field by field, silently, which is the failure mode the schema
// number exists to prevent.
func TestNodeSourceRejectsAnUnknownSchema(t *testing.T) {
	const addr = "0xabc"
	n := serveReducer(t,
		[]nodeDayIndex{{Day: "20261006", Hours: 24, Complete: true}},
		map[string]nodeDay{"20261006": {
			Schema: nodeSchema + 1, Day: "20261006", Hours: 24, Complete: true,
			Builders: map[string]*nodeTotals{addr: {VolumeUSD: 5}},
		}})
	if s := n.Summary([]string{addr}, "20261006"); s != nil {
		t.Fatalf("a day of an unknown shape was accepted: %+v", s)
	}
}

// Secondary addresses sum, the same way the mirror path merges them. MetaMask
// is the live case: the registry documents a second address it operates.
func TestNodeSourceSumsSecondaryAddresses(t *testing.T) {
	a1, a2 := "0x1111", "0x2222"
	n := serveReducer(t,
		[]nodeDayIndex{{Day: "20261006", Hours: 24, Complete: true}},
		map[string]nodeDay{"20261006": wholeDay("20261006", map[string]*nodeTotals{
			a1: {VolumeUSD: 10, FeesUSD: 1, Fills: 1, LastFill: 100,
				CoinVol: map[string]float64{"BTC": 10},
				Users:   map[string]*nodeUserAgg{"0xu": {Vol: 10, Fills: 1}}},
			a2: {VolumeUSD: 5, FeesUSD: 2, Fills: 3, LastFill: 500,
				CoinVol: map[string]float64{"BTC": 5, "ETH": 1},
				Users:   map[string]*nodeUserAgg{"0xu": {Vol: 5, Fills: 2}}},
		})})
	s := n.Summary([]string{a1, a2}, "20261006")
	if s == nil || s.vol != 15 || s.fees != 3 || s.fills != 4 {
		t.Fatalf("addresses did not sum: %+v", s)
	}
	if s.lastFillS != 500 {
		t.Fatalf("last fill should be the latest of the two, got %v", s.lastFillS)
	}
	if s.coinVol["BTC"] != 15 || s.coinVol["ETH"] != 1 {
		t.Fatalf("coin volume did not sum: %v", s.coinVol)
	}
	// One wallet trading through both addresses is one wallet.
	if len(s.users) != 1 || s.users["0xu"].vol != 15 || s.users["0xu"].fills != 3 {
		t.Fatalf("wallet did not merge: %v", s.users)
	}
}

// With nothing configured the harness runs exactly as it did before.
func TestNodeSourceAbsentWhenUnconfigured(t *testing.T) {
	t.Setenv("HL_NODE_REDUCE_URL", "")
	if n := newNodeSource(time.Second); n != nil {
		t.Fatal("a node source was built without an endpoint")
	}
}
