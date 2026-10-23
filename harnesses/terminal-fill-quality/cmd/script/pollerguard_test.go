package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Every poller that pages with a cursor must be able to say it fell behind.
//
// This bug has now cost this harness data three times and the shape is always
// identical: a pass asks for N, gets N, moves its cursor to the newest, and
// everything between the old cursor and that page is gone. A poller with no
// behind-counter cannot tell you it is behind, so it stays invisible until
// someone computes a rate and finds half of it missing. That is exactly how
// the Mobula join rate lost its other half for an evening.
//
// The census when this test was written:
//
//	pumpBridgeFeed      tfq_pump_bridge_feed_behind    had it (after a loss)
//	nativeFeed          tfq_native_lag_blocks          had it
//	mobulaFeed          nothing                        added
//	mobulaFillWatcher   a log line only                counted now
//	wallet fallback     nothing                        added
//
// Two of five. The two without an instrument were the two that lost data.
//
// So this guards the invariant rather than the instances: a paged signature
// read must sit near something that reports falling behind. It is a source
// test, which is unusual here, because the failure is an ABSENCE and no
// runtime assertion can see a counter that was never written.
func TestEveryPagedSignatureReadHasABehindGuard(t *testing.T) {
	dir := "."
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		t.Fatal(err)
	}
	// A paged read with a cursor: signatures(ctx, X, <page>, <cursor>) where
	// the cursor is not the empty string.
	call := regexp.MustCompile(`\.signatures\(ctx,\s*[^,]+,\s*[^,]+,\s*([^)]+)\)`)
	behind := regexp.MustCompile(`(?i)behind|lag|skipped`)

	checked := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		src := string(b)
		for _, m := range call.FindAllStringSubmatchIndex(src, -1) {
			cursor := strings.TrimSpace(src[m[2]:m[3]])
			if cursor == `""` {
				continue // a one-shot read, no cursor, nothing to fall behind
			}
			checked++
			// Look in the enclosing 40 lines for something that reports
			// falling behind. Crude on purpose: the point is that a human
			// writing a new poller trips this, not that it parses Go.
			start := m[0]
			lineStart := strings.LastIndex(src[:start], "\nfunc ")
			if lineStart < 0 {
				lineStart = 0
			}
			end := start + 2500
			if end > len(src) {
				end = len(src)
			}
			if !behind.MatchString(src[lineStart:end]) {
				t.Errorf("%s: a paged signature read with cursor %s sits in a function with nothing that reports falling behind.\n"+
					"Every poller that pages with a cursor must publish one: this bug has cost this harness data three times and\n"+
					"an absent counter is why it stayed invisible. See tfq_mobula_feed_behind or tfq_pump_bridge_feed_behind.",
					filepath.Base(f), cursor)
			}
		}
	}
	if checked < 3 {
		t.Fatalf("only %d paged signature reads found; the regex has probably stopped matching and this test is now vacuous", checked)
	}
}

// And the page size the guard compares against must be the one requested, or
// the guard can never fire. walletPollPage exists for exactly this: an inline
// 100 in the request and a different number in the check would look right.
func TestWalletPollGuardComparesTheRequestedPage(t *testing.T) {
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	if !strings.Contains(src, "rpc.signatures(ctx, w, walletPollPage, cur.Last)") {
		t.Fatal("the wallet poll no longer requests walletPollPage; the guard below it would compare against the wrong number")
	}
	if !strings.Contains(src, "len(sigs) >= walletPollPage") {
		t.Fatal("the wallet poll's behind-check no longer compares against walletPollPage")
	}
}
