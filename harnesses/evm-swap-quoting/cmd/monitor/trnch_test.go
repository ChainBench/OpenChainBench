package main

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func trnchAt(t *testing.T, status int, body string) (Quote, error) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	old := trnchBaseURL
	trnchBaseURL = srv.URL
	t.Cleanup(func() { trnchBaseURL = old })

	p := NewTrnchProvider("eu-west", "test-key")
	return p.Probe(context.Background(), TestPair{
		Chain: "robinhood", ChainId: 4663,
		TokenIn: NativeSentinel, TokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
		TokenInSym: "ETH", TokenOutSym: "USDG",
		AmountWei: "100000000000000000", TokenInDec: 18, TokenOutDec: 6,
	})
}

// A real body measured on 2026-11-02, trimmed to the fields the adapter
// reads. feeUsd 1.1331 on inUsd 226.6210 is 50.0 bps, which is what the
// four live comparisons against a direct KyberSwap quote also measured.
const trnchBody = `{
  "notice": "licence text that must never leave this response",
  "best": {"router": "kyberswap", "amountOut": "225281418", "inUsd": 226.62104836018895},
  "routes": [
    {"router": "kyberswap", "status": "ok", "feeUsd": 1.1331052418009446},
    {"router": "sushi", "status": "timeout", "feeUsd": null}
  ]
}`

func TestTrnchFeeIsReadFromTheChosenRoute(t *testing.T) {
	q, err := trnchAt(t, 200, trnchBody)
	if err != nil {
		t.Fatalf("a routed answer must parse: %v", err)
	}
	if q.OutAmount != "225281418" {
		t.Errorf("amount must survive verbatim, got %q", q.OutAmount)
	}
	if math.Abs(q.FeeBps-50.0) > 0.1 {
		t.Errorf("declared fee should read 50 bps, got %v", q.FeeBps)
	}
}

// The chosen route is kyberswap; sushi timed out and reports no fee. Reading
// the first route in the array instead of the chosen one would publish
// nothing here the day the order changes.
func TestTrnchIgnoresRoutesItDidNotChoose(t *testing.T) {
	body := `{"best": {"router": "sushi", "amountOut": "1000", "inUsd": 100},
	          "routes": [{"router": "kyberswap", "status": "ok", "feeUsd": 9.0},
	                     {"router": "sushi", "status": "ok", "feeUsd": 0.5}]}`
	q, err := trnchAt(t, 200, body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if math.Abs(q.FeeBps-50.0) > 0.1 {
		t.Errorf("fee must come from the chosen route, got %v", q.FeeBps)
	}
}

func TestTrnchUndeclaredFeeStaysMinusOne(t *testing.T) {
	body := `{"best": {"router": "kyberswap", "amountOut": "225281418", "inUsd": 226.6},
	          "routes": [{"router": "kyberswap", "status": "ok", "feeUsd": null}]}`
	q, err := trnchAt(t, 200, body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if q.FeeBps != -1 {
		t.Errorf("a route reporting no fee must stay -1, got %v", q.FeeBps)
	}
}

func TestTrnchAuthFailureIsNotAQuote(t *testing.T) {
	q, err := trnchAt(t, 401, `{"notice": "...", "error": "invalid or missing API key"}`)
	if err == nil || q.OK {
		t.Error("a 401 must not produce a quote")
	}
}

func TestTrnchEmptyBestIsNoRoute(t *testing.T) {
	q, err := trnchAt(t, 200, `{"best": {"router": "", "amountOut": ""}, "routes": []}`)
	if err == nil || q.OK {
		t.Error("an answer with no amount must not be published")
	}
}

func TestTrnchServesRobinhoodAlone(t *testing.T) {
	p := NewTrnchProvider("eu-west", "k")
	if !p.Supports(4663) {
		t.Error("Robinhood Chain is the chain it serves")
	}
	// The request carries no chain field, so any other chain would come back
	// priced on Robinhood and look like a real quote.
	for _, id := range []int{1, 56, 8453, 42161} {
		if p.Supports(id) {
			t.Errorf("chain %d must not be claimed: the request has no chain field", id)
		}
	}
}
