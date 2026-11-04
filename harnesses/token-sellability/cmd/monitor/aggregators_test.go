package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The reason an aggregator refused is in the body, and the log line is where
// it has to end up. A bare status cannot tell an unsupported chain from a
// token the aggregator cannot describe, and those call for opposite fixes.
func TestBadStatusCarriesTheReason(t *testing.T) {
	err := badStatus(400, []byte(`{"error":"destDecimals is required"}`))
	if !strings.Contains(err.Error(), "destDecimals") {
		t.Errorf("the body must reach the message, got %q", err)
	}
	if !strings.Contains(err.Error(), "400") {
		t.Errorf("the status must survive too, got %q", err)
	}
}

// A body spread over many lines would break the one-line log format, and a
// long one would bury the sweep summary.
func TestBadStatusStaysOnOneShortLine(t *testing.T) {
	err := badStatus(500, []byte("first line\n\n   second line\t"))
	if strings.ContainsAny(err.Error(), "\n\t") {
		t.Errorf("must collapse to one line, got %q", err)
	}
	if err.Error() != "http 500: first line second line" {
		t.Errorf("unexpected rendering %q", err)
	}

	long := badStatus(502, []byte(strings.Repeat("x", 500)))
	if len(long.Error()) > 200 {
		t.Errorf("must be trimmed, got %d chars", len(long.Error()))
	}
}

// An empty body still has to say something, or the log reads as a missing
// value rather than a silent upstream.
func TestBadStatusSaysWhenTheBodyIsEmpty(t *testing.T) {
	if got := badStatus(429, []byte("   ")).Error(); got != "http 429, empty body" {
		t.Errorf("got %q", got)
	}
}

// The slug and the id are hardcoded in the same file, so the one helper that
// relates them is worth pinning.
func TestChainSlugTracksTheID(t *testing.T) {
	if got := chainSlugFor(chainID); got != chainSlug {
		t.Errorf("the bench chain must map to its slug, got %q", got)
	}
	if got := chainSlugFor(1); got != "1" {
		t.Errorf("an unknown id falls back to its number, got %q", got)
	}
}

// The three bodies below are verbatim from the production log on
// 2026-11-04. Each one is an aggregator declining to route into a token our
// own simulation could not sell, which is the single most important event
// this bench records, and all three were being counted as outages.
func TestTheRefusalsWeActuallyReceiveCountAsDeclines(t *testing.T) {
	cases := []struct {
		name  string
		body  string
		known []refusal
	}{
		{
			"kyberswap has no route",
			`{"code":4008,"message":"route not found","details":null,"requestId":"4c8c7c5a"}`,
			kyberRefusals,
		},
		{
			"lifi denies the token",
			`{"message":"Token 4663-0xfc61c47c90e87566e11ef4e024c04f11e87c3fda is invalid or in deny list.","code":1011}`,
			lifiRefusals,
		},
		{
			"paraswap refuses on price impact",
			`{"error":"ESTIMATED_LOSS_GREATER_THAN_MAX_IMPACT","priceRoute":{"network":4663}}`,
			paraswapRefusals,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			no, why := isRefusal([]byte(c.body), c.known)
			if !no {
				t.Fatalf("must read as a decline, not an error: %s", c.body)
			}
			if why == "" {
				t.Error("a decline must carry its reason")
			}
		})
	}
}

// The mirrored mistake, and the more dangerous one: treating every non-200
// as a decline would score our own broken request as the best possible
// record, because declining is what wins on this board.
func TestAFaultIsNotADecline(t *testing.T) {
	faults := []string{
		`{"message":"Internal server error","code":500}`,
		`{"error":"rate limit exceeded"}`,
		`<html>502 Bad Gateway</html>`,
		``,
	}
	for _, body := range faults {
		for _, known := range [][]refusal{kyberRefusals, lifiRefusals, paraswapRefusals} {
			if no, _ := isRefusal([]byte(body), known); no {
				t.Errorf("%q must stay an error", body)
			}
		}
	}
}

// An aggregator's codes are its own: KyberSwap's 4008 must not silently
// excuse LI.FI, whose 4008 would mean something else entirely.
func TestRefusalCodesDoNotCrossAggregators(t *testing.T) {
	kyber := `{"code":4008,"message":"route not found"}`
	if no, _ := isRefusal([]byte(kyber), lifiRefusals); no {
		t.Error("kyberswap's code must not be read against lifi's table")
	}
	lifi := `{"code":1011,"message":"Token is invalid or in deny list."}`
	if no, _ := isRefusal([]byte(lifi), kyberRefusals); no {
		t.Error("lifi's code must not be read against kyberswap's table")
	}
}

// trnchNode serves one canned response so the adapter can be driven without
// the live API or the key.
func trnchNode(t *testing.T, status int, body string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			t.Error("the key must be sent")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	old := trnchQuoteURL
	trnchQuoteURL = srv.URL
	t.Cleanup(func() { trnchQuoteURL = old })
}

// The behaviour Trnch claims and this bench exists to check: they screen the
// token with their own agent before polling any router, and refuse. The body
// is verbatim from their API on 2026-11-04, asked about a token this harness
// had classified unsellable at both timings.
func TestTrnchRefusalIsADeclineNotAFault(t *testing.T) {
	trnchNode(t, 409, `{"error":"token not tradable through TRNCH"}`)
	ok, err := trnchAgg{http.DefaultClient, "k"}.WillQuote(context.Background(), "0xtok", "1")
	if err != nil {
		t.Fatalf("a refusal must not be an error: %v", err)
	}
	if ok {
		t.Error("a refusal must not count as a route")
	}
}

func TestTrnchQuoteCountsAsRouted(t *testing.T) {
	trnchNode(t, 200, `{"best":{"router":"kyberswap","amountOut":"46123722"},"routes":[]}`)
	ok, err := trnchAgg{http.DefaultClient, "k"}.WillQuote(context.Background(), "0xtok", "1")
	if err != nil || !ok {
		t.Errorf("a real quote must count as routed, got ok=%v err=%v", ok, err)
	}
}

// A zero amount is a refusal dressed as a quote, and reading it as a route
// would credit them with something they declined.
func TestTrnchZeroAmountIsNotARoute(t *testing.T) {
	trnchNode(t, 200, `{"best":{"amountOut":"0"}}`)
	ok, _ := trnchAgg{http.DefaultClient, "k"}.WillQuote(context.Background(), "0xtok", "1")
	if ok {
		t.Error("zero out must not count as a route")
	}
}

// Their licence notice rides on every response and must not reach a log, an
// error, or anything else we keep.
func TestTrnchNoticeNeverReachesAnError(t *testing.T) {
	notice := "RESTRICTED: no redistribution of this data without written consent"
	body, _ := json.Marshal(map[string]any{
		"error":  "internal failure",
		"notice": notice,
	})
	trnchNode(t, 500, string(body))
	_, err := trnchAgg{http.DefaultClient, "k"}.WillQuote(context.Background(), "0xtok", "1")
	if err == nil {
		t.Fatal("a 500 is a fault and must surface")
	}
	if strings.Contains(err.Error(), "RESTRICTED") || strings.Contains(err.Error(), "redistribution") {
		t.Errorf("their notice must never be carried: %q", err)
	}
	if !strings.Contains(err.Error(), "internal failure") {
		t.Errorf("their own error field should be kept: %q", err)
	}
}

// The withdrawal switch. Without the key Trnch is not built at all, so no
// request is made and the row is absent rather than scoring the zero that
// wins this board.
func TestTrnchIsAbsentWithoutItsKey(t *testing.T) {
	t.Setenv("TRNCH_API_KEY", "")
	for _, a := range Aggregators() {
		if a.Slug() == "trnch" {
			t.Fatal("no key must mean no trnch, and therefore no row")
		}
	}
	t.Setenv("TRNCH_API_KEY", "something")
	found := false
	for _, a := range Aggregators() {
		if a.Slug() == "trnch" {
			found = true
		}
	}
	if !found {
		t.Error("a key must put trnch back in the cohort")
	}
}
