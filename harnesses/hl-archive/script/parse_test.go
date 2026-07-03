package script

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/pierrec/lz4/v4"
)

func init() { initLogger() }

const sampleCSV = `time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee
1748736000000,0xuserA,BTC,B,60000,0.1,1,,Gtc,false,0xcp,0,,0.5
1748736001000,0xuserB,BTC,S,60010,0.2,1,,Gtc,false,0xcp,0,,1.2
1748736002000,0xuserA,ETH,B,3000,1,1,,Gtc,false,0xcp,0,,0.3
`

func lz4Encode(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := lz4.NewWriter(&buf)
	if _, err := w.Write(raw); err != nil {
		t.Fatalf("lz4 write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("lz4 close: %v", err)
	}
	return buf.Bytes()
}

func TestFetchDay_ParsesAndAggregates(t *testing.T) {
	body := lz4Encode(t, []byte(sampleCSV))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	prev := HTTPClient
	defer func() { HTTPClient = prev }()
	HTTPClient = srv.Client()
	// Redirect the CDN to httptest by overriding URL in test via custom RoundTripper.
	HTTPClient.Transport = &redirectingTransport{target: srv.URL}

	agg := NewDayAggregator("2026-05-31", "0xb84168cf3be63c6b8dad05ff5d755e97432ff80b")
	n, err := FetchDay(context.Background(), "0xb84168cf3be63c6b8dad05ff5d755e97432ff80b", time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC), func(f Fill) error {
		agg.Add(f)
		return nil
	})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if n != 3 {
		t.Fatalf("expected 3 rows, got %d", n)
	}
	rows := agg.Rows()
	sort.Slice(rows, func(i, j int) bool { return rows[i].Key.Asset < rows[j].Key.Asset })
	if len(rows) != 2 {
		t.Fatalf("expected 2 asset buckets, got %d", len(rows))
	}
	// BTC: 60000*0.1 + 60010*0.2 = 6000 + 12002 = 18002
	// ETH: 3000*1 = 3000
	if rows[0].Key.Asset != "BTC" || rows[0].VolumeUSD != 18002 {
		t.Errorf("BTC volume: got %+v", rows[0])
	}
	if rows[0].FeesUSD != 1.7 {
		t.Errorf("BTC fees: got %v want 1.7", rows[0].FeesUSD)
	}
	if rows[0].UniqueUsers != 2 {
		t.Errorf("BTC unique users: got %d", rows[0].UniqueUsers)
	}
	if rows[1].Key.Asset != "ETH" || rows[1].VolumeUSD != 3000 || rows[1].FillCount != 1 {
		t.Errorf("ETH row: got %+v", rows[1])
	}
}

func TestFetchDay_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	}))
	defer srv.Close()

	prev := HTTPClient
	defer func() { HTTPClient = prev }()
	HTTPClient = srv.Client()
	HTTPClient.Transport = &redirectingTransport{target: srv.URL}

	_, err := FetchDay(context.Background(), "0xdead", time.Now().UTC(), func(Fill) error { return nil })
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// redirectingTransport rewrites every outbound request to the test server.
type redirectingTransport struct{ target string }

func (rt *redirectingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	u := req.URL
	u.Scheme = "http"
	u.Host = trimScheme(rt.target)
	req.Host = u.Host
	return http.DefaultTransport.RoundTrip(req)
}

func trimScheme(s string) string {
	for _, p := range []string{"http://", "https://"} {
		if len(s) > len(p) && s[:len(p)] == p {
			return s[len(p):]
		}
	}
	return s
}
