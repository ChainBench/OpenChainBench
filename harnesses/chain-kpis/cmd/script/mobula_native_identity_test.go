package main

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

type nativeFixtureTransport func(*http.Request) (*http.Response, error)

func (f nativeFixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestNativePricesCarryRequestedAssetIdentity(t *testing.T) {
	original := httpClientMobula
	t.Cleanup(func() { httpClientMobula = original })
	for _, tc := range []struct {
		slug, symbol string
		id           int
	}{
		{"native-identity-pinned", "FRAX", 100004858},
		{"native-identity-symbol", "ETH", 0},
	} {
		t.Run(tc.slug, func(t *testing.T) {
			assetID := ""
			if tc.id > 0 {
				assetID = strconv.Itoa(tc.id)
			}
			httpClientMobula = &http.Client{Transport: nativeFixtureTransport(func(r *http.Request) (*http.Response, error) {
				q := r.URL.Query()
				if tc.id > 0 {
					if q.Get("id") != assetID || q.Has("symbol") {
						t.Fatalf("wrong asset query: %s", r.URL.RawQuery)
					}
				} else if q.Get("symbol") != tc.symbol || q.Has("id") {
					t.Fatalf("wrong symbol query: %s", r.URL.RawQuery)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"data":{"price":0.25,"market_cap":23000000}}`)), Header: make(http.Header)}, nil
			})}
			fetchMobulaNative(&Config{MobulaAPIKey: "test-fixture"}, tc.symbol, tc.id, []Chain{{Slug: tc.slug}})
			for _, gauge := range []*prometheus.GaugeVec{chainNativePriceUsd, chainNativeMcapUsd} {
				metric := &dto.Metric{}
				if err := gauge.WithLabelValues(tc.slug, tc.symbol, assetID).Write(metric); err != nil {
					t.Fatal(err)
				}
				found := false
				for _, label := range metric.Label {
					if label.GetName() == "asset_id" {
						found = label.GetValue() == assetID
					}
				}
				if !found || metric.GetGauge().GetValue() <= 0 {
					t.Fatalf("missing asset identity/value: %v", metric)
				}
				gauge.DeleteLabelValues(tc.slug, tc.symbol, assetID)
			}
		})
	}
}
