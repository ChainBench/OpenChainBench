package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

type codexRequest struct {
	Query     string `json:"query"`
	Variables struct {
		Input struct {
			WalletAddresses []string `json:"walletAddresses"`
			NetworkID       int      `json:"networkId"`
		} `json:"input"`
	} `json:"variables"`
}

// codexServer answers every request with body and records the last one.
func codexServer(t *testing.T, status int, body string) (*codexRequest, *string, func()) {
	t.Helper()
	got := &codexRequest{}
	auth := new(string)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, got)
		*auth = r.Header.Get("Authorization")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	prev := codexGraphQLURL
	codexGraphQLURL = srv.URL
	return got, auth, func() {
		codexGraphQLURL = prev
		srv.Close()
	}
}

func TestCodexNamesTheWalletOnTheAnchorsChain(t *testing.T) {
	got, auth, done := codexServer(t, 200, `{"data":{"wallets":[{"displayName":"Binance: Hot Wallet"}]}}`)
	defer done()

	res := NewCodexProvider("k").Lookup(context.Background(), "bnb", "0x8894e0a0c962cb723c1976a4421c95949be2d4e3")

	if !res.HasLabel || res.Label != "Binance: Hot Wallet" || res.Err != nil {
		t.Fatalf("got %+v", res)
	}
	if *auth != "k" {
		t.Fatalf("authorization %q", *auth)
	}
	in := got.Variables.Input
	if in.NetworkID != 56 || len(in.WalletAddresses) != 1 || in.WalletAddresses[0] != "0x8894e0a0c962cb723c1976a4421c95949be2d4e3" {
		t.Fatalf("input %+v", in)
	}
}

func TestCodexCountsNoRecordAndGenericNamesAsMisses(t *testing.T) {
	for _, body := range []string{`{"data":{"wallets":[null]}}`, `{"data":{"wallets":[{"displayName":"Wallet"}]}}`, `{"data":{"wallets":[{"displayName":""}]}}`} {
		_, _, done := codexServer(t, 200, body)
		res := NewCodexProvider("k").Lookup(context.Background(), "ethereum", "0x0000000000000000000000000000000000000001")
		done()
		if res.HasLabel || res.Err != nil {
			t.Fatalf("%s: got %+v", body, res)
		}
	}
}

func TestCodexReportsGraphQLAndHTTPErrors(t *testing.T) {
	_, _, done := codexServer(t, 200, `{"errors":[{"message":"Invalid networkId: 3"}],"data":null}`)
	res := NewCodexProvider("k").Lookup(context.Background(), "solana", "DSoamqV65mzouroy6nc6kKrwPbZ9nBgcTyYisEmyoDuc")
	done()
	if res.Err == nil || res.HasLabel {
		t.Fatalf("graphql error: got %+v", res)
	}

	_, _, done = codexServer(t, 429, `{}`)
	res = NewCodexProvider("k").Lookup(context.Background(), "solana", "DSoamqV65mzouroy6nc6kKrwPbZ9nBgcTyYisEmyoDuc")
	done()
	if res.Err == nil || res.Err.Error() != "status_429" {
		t.Fatalf("http error: got %+v", res)
	}
}

func TestCodexSkipsUnsupportedChainsAndMissingKey(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer srv.Close()
	prev := codexGraphQLURL
	codexGraphQLURL = srv.URL
	defer func() { codexGraphQLURL = prev }()

	if res := NewCodexProvider("k").Lookup(context.Background(), "ton", "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT"); res.HasLabel || res.Err != nil {
		t.Fatalf("ton: got %+v", res)
	}
	if res := NewCodexProvider("").Lookup(context.Background(), "ethereum", "0x0000000000000000000000000000000000000001"); res.HasLabel || res.Err != nil {
		t.Fatalf("no key: got %+v", res)
	}
	if calls != 0 {
		t.Fatalf("made %d calls", calls)
	}
}
