package main

import (
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
