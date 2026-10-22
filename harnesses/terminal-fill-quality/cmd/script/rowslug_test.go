package main

import "testing"

// No two row producers may own the same slug.
//
// xchainRows builds <app>-<chain> from the Relay feed and evmTerminals declares
// its own rows; both record into the same state under the same name, so a
// collision does not sum or average, it lets whichever row is written last win,
// silently and differently from one tick to the next.
//
// This is a regression test, not a precaution. Adding the six pump.fun bridge
// rows collided with the Relay rows and the published JSON carried
// pump-fun-bnb, -base, -arc, -robinhood, -megaeth and -xlayer twice each: 72
// entries where 66 were intended, with nothing else in the file duplicated. It
// reached production and the page served a number chosen by a race.
func TestNoProducerSharesARowSlug(t *testing.T) {
	owner := map[string]string{}
	for _, slug := range xchainRows() {
		if prev, ok := owner[slug]; ok {
			t.Errorf("%q produced twice by %s", slug, prev)
		}
		owner[slug] = "xchainRows"
	}
	for _, term := range evmTerminals {
		if prev, ok := owner[term.Slug]; ok {
			t.Errorf("%q is declared by evmTerminals and also produced by %s; "+
				"two producers write one series and the last one wins",
				term.Slug, prev)
		}
		owner[term.Slug] = "evmTerminals"
	}
}

// Every pump.fun bridge row must be the sole owner of its name.
//
// Named apart from the general test because this is the pairing that broke, and
// because the fix is a deliberate choice rather than an accident of ordering:
// pump made its own bridge the default on 2026-10-07, so the native row reading
// the router wins and the legacy Relay row for that chain is dropped.
func TestPumpBridgeRowsOwnTheirSlugs(t *testing.T) {
	relay := map[string]bool{}
	for _, slug := range xchainRows() {
		relay[slug] = true
	}
	found := 0
	for _, term := range evmTerminals {
		if len(term.Slug) < 9 || term.Slug[:9] != "pump-fun-" {
			continue
		}
		found++
		if relay[term.Slug] {
			t.Errorf("%q is still emitted by the Relay feed as well", term.Slug)
		}
	}
	if found == 0 {
		t.Error("no pump.fun bridge row found in evmTerminals")
	}
}

// The dedupe must remove only what it is meant to.
//
// Skipping a slug in xchainRows silently drops a row, so the guard has to be
// narrow: every app that is not pump.fun keeps a row on every origin chain, and
// each app keeps its funding row whatever else happens.
func TestDedupeDropsOnlyThePumpBridgeChains(t *testing.T) {
	got := map[string]bool{}
	for _, slug := range xchainRows() {
		got[slug] = true
	}
	for _, a := range xchainApps {
		if !got[a.Slug+"-funding"] {
			t.Errorf("%s lost its funding row", a.Slug)
		}
		if a.FundingOnly {
			continue
		}
		for _, c := range originChains {
			slug := a.Slug + "-" + c.slug
			want := !nativeOwnsSlug(slug)
			if got[slug] != want {
				t.Errorf("%s: present=%v, want %v", slug, got[slug], want)
			}
		}
	}
}
