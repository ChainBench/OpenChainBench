package main

import (
	"strings"
	"testing"
)

// A cross-chain app must declare at least one fee recipient or a referrer, or
// its requests can never be recognised and every one of its rows is ABSENT.
//
// This is the failure mode with no symptom. Phantom's recipient changed and
// the declared one went to 0 appearances in 100 requests; nothing errored,
// nothing logged, and the phantom-<chain> rows simply never appeared. An
// absent row reads as "the app does not do this" rather than "we stopped
// being able to see it", so there is no number for anyone to notice is wrong.
func TestEveryXchainAppCanBeRecognised(t *testing.T) {
	for _, a := range xchainApps {
		if a.Referrer == "" && len(a.FeeRecipients) == 0 {
			t.Fatalf("%s declares neither a referrer nor a fee recipient: its rows can never fill", a.Slug)
		}
	}
}

// Recipients are compared against Relay's lower-case addresses, so a declared
// address with any upper case silently matches nothing. Same class of defect:
// no error, no log, just rows that never fill.
func TestFeeRecipientsAreLowerCase(t *testing.T) {
	for _, a := range xchainApps {
		for _, r := range a.FeeRecipients {
			if r != strings.ToLower(r) {
				t.Fatalf("%s declares %s with upper case; the comparison would never match", a.Slug, r)
			}
			if !strings.HasPrefix(r, "0x") || len(r) != 42 {
				t.Fatalf("%s declares %q, which is not a 20-byte address", a.Slug, r)
			}
		}
	}
}

// Phantom keeps BOTH addresses on purpose: the live one and the one it moved
// off. Dropping the old one would cost nothing today and blind the rows again
// if Phantom rolled back, which is the same reasoning as never deleting a row
// whose slug moved.
func TestPhantomKeepsBothFeeRecipients(t *testing.T) {
	var ph *xchainApp
	for i := range xchainApps {
		if xchainApps[i].Slug == "phantom" {
			ph = &xchainApps[i]
		}
	}
	if ph == nil {
		t.Fatal("phantom is no longer declared as a cross-chain app")
	}
	want := map[string]bool{
		"0x037da4f70ea2e62c3c7a962a3bce5fcc41509a02": false, // live, 83 of 100
		"0x74f9cb25fd81db31b4daf97ec121c01873581a57": false, // moved off, 0 of 100
	}
	for _, r := range ph.FeeRecipients {
		if _, ok := want[r]; ok {
			want[r] = true
		}
	}
	for addr, found := range want {
		if !found {
			t.Fatalf("phantom no longer declares %s; see the comment for why both are kept", addr)
		}
	}
}

// No two apps may share a fee recipient, or the requests of one are published
// as the other's. Attribution is the whole basis of this bench.
func TestNoTwoAppsShareAFeeRecipient(t *testing.T) {
	owner := map[string]string{}
	for _, a := range xchainApps {
		for _, r := range a.FeeRecipients {
			if prev, dup := owner[r]; dup {
				t.Fatalf("%s and %s both claim %s: one app's requests would publish as the other's", prev, a.Slug, r)
			}
			owner[r] = a.Slug
		}
	}
}
