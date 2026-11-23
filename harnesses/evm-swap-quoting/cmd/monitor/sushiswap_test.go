package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Sushi answers 200 with a status field rather than an HTTP error when it
// cannot build a route, so the status has to be read before the amount.
// Without that check the adapter would publish a successful quote carrying
// whatever assumedAmountOut happened to be, and an empty one scales to zero,
// which reads on the board as "this provider gives you nothing" rather than
// "this provider had no route". These are the two cases that separate.
func sushiAt(t *testing.T, body string) (Quote, error) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	old := sushiBaseURL
	sushiBaseURL = srv.URL
	t.Cleanup(func() { sushiBaseURL = old })

	p := NewSushiSwapProvider("eu-west")
	return p.Probe(context.Background(), TestPair{
		Chain: "robinhood", ChainId: 4663,
		TokenIn: NativeSentinel, TokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
		TokenInSym: "ETH", TokenOutSym: "USDG",
		AmountWei: "100000000000000000", TokenInDec: 18, TokenOutDec: 6,
	})
}

func TestSushiNoRouteIsNotAZeroQuote(t *testing.T) {
	q, err := sushiAt(t, `{"status":"NoWay"}`)
	if err == nil {
		t.Fatal("a status that carries no route must return an error")
	}
	if q.OK {
		t.Error("a routeless answer must not be published as a quote")
	}
	if q.OutAmount != "" {
		t.Errorf("a routeless answer must carry no amount, got %q", q.OutAmount)
	}
}

// The live body measured on 2026-11-02: 0.1 ETH bought 228.52 USDG.
func TestSushiSuccessCarriesTheAmountAndDeclaresNoFee(t *testing.T) {
	q, err := sushiAt(t, `{"status":"Success","assumedAmountOut":"228522586","gasSpent":320000}`)
	if err != nil {
		t.Fatalf("a routed answer must parse: %v", err)
	}
	if !q.OK {
		t.Fatal("a routed answer must be published")
	}
	if q.OutAmount != "228522586" {
		t.Errorf("amount must survive verbatim, got %q", q.OutAmount)
	}
	if q.GasUnits != 320000 {
		t.Errorf("gasSpent must reach GasUnits, got %d", q.GasUnits)
	}
	// Sushi declares no fee. -1 says "said nothing"; 0 would say "said zero",
	// and publishing the second would rank it as the cheapest by default.
	if q.FeeBps != -1 {
		t.Errorf("an undeclared fee must stay -1, got %v", q.FeeBps)
	}
}

func TestSushiHttpErrorIsNotAQuote(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"status":"Success","assumedAmountOut":"999999999"}`))
	}))
	t.Cleanup(srv.Close)
	old := sushiBaseURL
	sushiBaseURL = srv.URL
	t.Cleanup(func() { sushiBaseURL = old })

	p := NewSushiSwapProvider("eu-west")
	q, err := p.Probe(context.Background(), TestPair{
		Chain: "robinhood", ChainId: 4663, TokenIn: NativeSentinel,
		TokenOut:   "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
		TokenInSym: "ETH", TokenOutSym: "USDG",
		AmountWei: "100000000000000000", TokenInDec: 18, TokenOutDec: 6,
	})
	if err == nil || q.OK {
		t.Error("a non-200 must not be read for an amount, however well-formed its body")
	}
}

func TestSushiServesTheRobinhoodCohort(t *testing.T) {
	p := NewSushiSwapProvider("eu-west")
	// Probed live on 2026-11-02; these are the basket's chains.
	for _, id := range []int{1, 56, 8453, 42161, 4663} {
		if !p.Supports(id) {
			t.Errorf("chain %d answered live and must be declared", id)
		}
	}
	if p.Supports(43114) {
		t.Error("avalanche was not probed and must not be claimed")
	}
}
