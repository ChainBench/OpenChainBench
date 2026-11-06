package main

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

// The endpoint this harness talks to carries its credential as a path
// segment, so there is no header to redact: either the URL stays out of the
// error or the key reaches the log. Go folds the whole request URL into
// *url.Error and net/http returns that from both Do and NewRequest, so this
// is the exact shape that would have been printed.
//
// The guard is tested with the shape it exists for, because a guard that has
// never had its own case put through it is a comment.
func TestWithoutURLKeepsTheKeyOut(t *testing.T) {
	const key = "0123456789abcdef0123456789abcdef"
	endpoint := "https://stylish-patient-mountain.example.quiknode.pro/" + key + "/"

	cases := []error{
		&url.Error{Op: "Post", URL: endpoint,
			Err: errors.New("dial tcp 1.2.3.4:443: connect: connection refused")},
		&url.Error{Op: "Post", URL: endpoint, Err: nil},
		// Wrapped, because callers add their own context on the way up.
		fmt.Errorf("unreadable simulation: %w",
			&url.Error{Op: "Post", URL: endpoint,
				Err: errors.New("context deadline exceeded")}),
	}

	for _, in := range cases {
		// Establish that the input really does carry the key, so a change to
		// net/url that stopped including it could not make this test vacuous.
		if !strings.Contains(in.Error(), key) {
			t.Fatalf("the case under test no longer carries the key: %v", in)
		}
		out := withoutURL(in)
		if out == nil {
			t.Fatal("withoutURL dropped the error entirely")
		}
		got := out.Error()
		if strings.Contains(got, key) {
			t.Errorf("key survived: %q", got)
		}
		if strings.Contains(got, "quiknode") || strings.Contains(got, "https://") {
			t.Errorf("endpoint survived: %q", got)
		}
		if got == "" {
			t.Error("withoutURL left nothing for a reader")
		}
	}
}

// A plain error must pass through untouched: scrubbing is for the transport,
// and a verdict reason that lost its text would be a different bug.
func TestWithoutURLLeavesOtherErrorsAlone(t *testing.T) {
	in := errors.New("node ran 0 of 3 calls")
	if got := withoutURL(in).Error(); got != in.Error() {
		t.Errorf("rewrote an unrelated error: %q", got)
	}
}

// decodeRevert reads the payload the node puts in error.data, which is where
// the reason was for the eight tokens that logged a bare "execution
// reverted" while returnData came back 0x. Both selectors were seen in the
// replay and hashed from their signatures.
func TestDecodeRevertNamesCustomErrors(t *testing.T) {
	for in, want := range map[string]string{
		"0x63ecb9f6": "custom error 0x63ecb9f6", // MinimalOutputBalanceViolation
		"0x5212cba1": "custom error 0x5212cba1", // CurrencyNotSettled
		"":           "",
		"0x":         "",
		"0x1234":     "", // too short to name anything
	} {
		if got := decodeRevert(in); got != want {
			t.Errorf("decodeRevert(%q) = %q, want %q", in, got, want)
		}
	}
}
