package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// recordingTransport answers every request with an empty 200 and keeps the
// last request it saw, so a test can read what an adapter sent without
// reaching the provider.
type recordingTransport struct {
	query url.Values
	body  []byte
}

func (rt *recordingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	rt.query = r.URL.Query()
	rt.body = nil
	if r.Body != nil {
		rt.body, _ = io.ReadAll(r.Body)
	}
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader("{}")),
		Header:     http.Header{},
		Request:    r,
	}, nil
}

// The probe is "1 USDC -> token" on every chain. USDC on BNB Chain
// (0x8AC76a51...580d) has 18 decimals, not 6, so one USDC there is 1e18 base
// units; 1000000 is 0.000000000001 USDC.
func TestEVMProbesQuoteOneStableUnit(t *testing.T) {
	want := map[string]string{
		"base":      "1000000",
		"robinhood": "1000000",
		"bsc":       "1000000000000000000",
	}
	type probe struct {
		name   string
		quote  func(*http.Client, Token)
		amount func(*recordingTransport) string
	}
	fromBody := func(rt *recordingTransport, read func(map[string]any) any) string {
		var m map[string]any
		if err := json.Unmarshal(rt.body, &m); err != nil {
			return ""
		}
		s, _ := read(m).(string)
		return s
	}
	probes := []probe{
		{"kyberswap", func(c *http.Client, tk Token) { (&KyberSwapProvider{client: c}).Quote(context.Background(), tk) },
			func(rt *recordingTransport) string { return rt.query.Get("amountIn") }},
		{"paraswap", func(c *http.Client, tk Token) { (&ParaSwapProvider{client: c}).Quote(context.Background(), tk) },
			func(rt *recordingTransport) string { return rt.query.Get("amount") }},
		{"odos", func(c *http.Client, tk Token) {
			(&OdosProvider{client: c, sem: make(chan struct{}, 1)}).Quote(context.Background(), tk)
		}, func(rt *recordingTransport) string {
			return fromBody(rt, func(m map[string]any) any {
				in, _ := m["inputTokens"].([]any)
				if len(in) == 0 {
					return nil
				}
				first, _ := in[0].(map[string]any)
				return first["amount"]
			})
		}},
		{"relay", func(c *http.Client, tk Token) { (&RelayProvider{client: c}).Quote(context.Background(), tk) },
			func(rt *recordingTransport) string {
				return fromBody(rt, func(m map[string]any) any { return m["amount"] })
			}},
	}
	for _, p := range probes {
		for chain, amount := range want {
			rt := &recordingTransport{}
			p.quote(&http.Client{Transport: rt}, Token{Address: "0x0000000000000000000000000000000000000002", Chain: chain, Venue: "test"})
			if got := p.amount(rt); got != amount {
				t.Errorf("%s on %s quoted %q base units of the stable, want %q (one unit)", p.name, chain, got, amount)
			}
		}
	}
}

// ParaSwap values the input with srcDecimals, so it has to match the token.
func TestParaSwapSendsTheStablesDecimals(t *testing.T) {
	for chain, want := range map[string]string{"base": "6", "robinhood": "6", "bsc": "18"} {
		rt := &recordingTransport{}
		(&ParaSwapProvider{client: &http.Client{Transport: rt}}).Quote(context.Background(), Token{Address: "0x0000000000000000000000000000000000000002", Chain: chain, Venue: "test"})
		if got := rt.query.Get("srcDecimals"); got != want {
			t.Errorf("paraswap on %s: srcDecimals=%q, want %q", chain, got, want)
		}
		if rt.query.Has("destDecimals") {
			t.Errorf("paraswap on %s sent destDecimals=%q; the destination's decimals are unknown here", chain, rt.query.Get("destDecimals"))
		}
	}
}
