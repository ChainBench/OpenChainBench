package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The sample is taken on the source's latest day, never on the latest day that
// happens to carry a number.
//
// basedbot is the case that forced this: $419M on Robinhood against $15.8M on
// Solana over 30 days, and zero Solana volume in the last 7. Walking back to its
// last live Solana day would publish a Robinhood bot as a Solana participant on
// a bench whose question is "in the last 24 hours".
func TestLatestSamplesDoesNotWalkBackToTheLastLiveDay(t *testing.T) {
	d := &botDetail{
		Bot:  "basedbot",
		Days: []string{"2026-10-04", "2026-10-05", "2026-10-06"},
	}
	d.Series = append(d.Series, chainSeries{
		Name:      "solana",
		VolumeUSD: []float64{5000, 0, 0},
		Txns:      []float64{50, 0, 0},
		FeesUSD:   []float64{35, 0, 0},
		Wallets:   []float64{25, 0, 0},
	})
	d.Series = append(d.Series, chainSeries{
		Name:      "robinhood",
		VolumeUSD: []float64{1000, 2000, 3000},
		Txns:      []float64{10, 20, 30},
		FeesUSD:   []float64{7, 14, 21},
		Wallets:   []float64{5, 10, 15},
	})

	got := latestSamples(d)
	if len(got) != 1 {
		t.Fatalf("expected only the chain active on the latest day, got %d samples: %+v", len(got), got)
	}
	if got[0].Chain != "robinhood" {
		t.Errorf("expected robinhood, got %q", got[0].Chain)
	}
	if got[0].Day != "2026-10-06" {
		t.Errorf("expected the source's latest day, got %q", got[0].Day)
	}
	if got[0].Volume != 3000 {
		t.Errorf("expected the latest day's volume 3000, got %v", got[0].Volume)
	}
}

// A short or absent per-day array must not panic the harness. The API documents
// every series array as aligned to `days` and v1 as additive-only, but that
// promise is about fields, not lengths.
func TestShortSeriesArrayDoesNotPanic(t *testing.T) {
	d := &botDetail{Bot: "gmgn", Days: []string{"2026-10-05", "2026-10-06"}}
	d.Series = append(d.Series, chainSeries{Name: "solana", VolumeUSD: []float64{100}, Txns: nil})

	if got := latestSamples(d); len(got) != 0 {
		t.Errorf("a series with no value on the latest day publishes nothing, got %+v", got)
	}
	if at(nil, 0) != 0 || at([]float64{1}, 5) != 0 || at([]float64{1}, -1) != 0 {
		t.Error("at must be bounds-safe in both directions")
	}
}

// An empty day list is not a cycle worth publishing.
func TestNoDaysMeansNoSamples(t *testing.T) {
	if got := latestSamples(&botDetail{Bot: "x"}); got != nil {
		t.Errorf("expected nil, got %+v", got)
	}
	if got := latestSamples(nil); got != nil {
		t.Errorf("expected nil for a nil detail, got %+v", got)
	}
}

// A non-200 is an error, not an empty result. An empty result would be
// indistinguishable from a quiet market and would drop the whole board.
func TestNon200IsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"boom"}`))
	}))
	defer srv.Close()
	c := newAPIClient(srv.URL, 5*time.Second)
	if _, err := c.roster(); err == nil {
		t.Error("expected an error on HTTP 500")
	}
}

// 429 is reported as rate limiting, because it is the one failure the caller
// fixes by slowing down rather than retrying.
func TestRateLimitIsNamed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c := newAPIClient(srv.URL, 5*time.Second)
	_, err := c.roster()
	if err == nil {
		t.Fatal("expected an error on HTTP 429")
	}
	if want := "rate limited"; len(err.Error()) < len(want) || err.Error()[:len(want)] != want {
		t.Errorf("expected a rate-limit error, got %v", err)
	}
}

// The roster is read over the full history so a dormant platform stays in it.
// A platform that disappears from the roster reads on the board exactly like a
// platform that was never offered, which is how a withdrawal becomes invisible.
func TestRosterIsReadOverFullHistory(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(botsRoster{
			Through: "2026-10-06",
			Series: []struct {
				Name        string `json:"name"`
				DisplayName string `json:"display_name"`
			}{{Name: "axiom"}, {Name: ""}, {Name: "bullx"}, {Name: "pumpapp"}},
		})
	}))
	defer srv.Close()
	c := newAPIClient(srv.URL, 5*time.Second)
	got, err := c.roster()
	if err != nil {
		t.Fatalf("roster: %v", err)
	}
	if gotQuery != "window=all&group=bot" {
		t.Errorf("roster must ask for the full history, asked %q", gotQuery)
	}
	// RAW ids: this list addresses the API, which 404s on a canonical slug.
	want := []string{"axiom", "bullx", "pumpapp"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %+v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("roster[%d]: got %q want %q", i, got[i], want[i])
		}
	}
}

// canonicalRoster is the other half, and the two must not be conflated. The
// roster addresses the API, which only knows its own ids; publish() compares
// against samples carrying our slugs. Canonicalising the fetch list made every
// renamed bot a 404 and dropped both rows; leaving the comparison list raw
// publishes a phantom unhealthy row beside each real one.
func TestCanonicalRosterConvertsOnlyForComparison(t *testing.T) {
	got := canonicalRoster([]string{"axiom", "pumpapp", "terminal", "pumpapp"})
	want := []string{"axiom", "pump-fun", "padre"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d]: got %q want %q", i, got[i], want[i])
		}
	}
}
