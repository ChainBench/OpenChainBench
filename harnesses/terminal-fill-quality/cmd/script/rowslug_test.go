package main

import (
	"strings"
	"testing"
)

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
	// cohort() first, because it is what compute() walks and therefore what
	// decides the published rows. The first version of this test checked
	// xchainRows() against evmTerminals instead, passed, and the six
	// duplicated rows went on being published: cohort builds the same
	// <app>-<chain> names independently, so guarding only xchainRows fixed
	// nothing while the suite said it had.
	seen := map[string]int{}
	for _, term := range cohort() {
		seen[term.Slug]++
	}
	for slug, n := range seen {
		if n > 1 {
			t.Errorf("cohort() yields %q %d times; two rows write one series "+
				"and the last one wins", slug, n)
		}
	}

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

// Both of pump's routes must publish, under names that cannot collide.
//
// This replaces a test that asserted the opposite. When the bridge rows were
// added they took the pump-fun-<chain> names, collided with the Relay rows,
// and the published JSON carried each twice; the fix chosen then was to drop
// the Relay row for any chain the bridge covers. That threw away half the
// comparison. Relay's own published chart puts pump.fun via Relay beside
// pump.fun via Pump Bridge, and with the Relay rows gone we could not draw it.
//
// Naming the bridge rows for the route instead removes the collision at the
// source and keeps both lines, so this test pins what the page needs: on every
// chain both routes serve, each publishes exactly once.
func TestBothPumpRoutesPublishSeparately(t *testing.T) {
	count := map[string]int{}
	for _, term := range cohort() {
		count[term.Slug]++
	}

	bridged := 0
	for _, term := range evmTerminals {
		if !strings.HasPrefix(term.Slug, "pump-bridge-") {
			continue
		}
		bridged++
		if count[term.Slug] != 1 {
			t.Errorf("cohort() yields %q %d times, want exactly 1",
				term.Slug, count[term.Slug])
		}
		// The Relay row for the same chain must still be there, on every
		// chain Relay reaches. MegaETH and X Layer it does not (relaySkips),
		// and there Pump Bridge is the only route.
		chain := strings.TrimPrefix(term.Slug, "pump-bridge-")
		if relaySkips[chain] {
			continue
		}
		if count["pump-fun-"+chain] != 1 {
			t.Errorf("pump-fun-%s published %d times; the Relay route is the "+
				"other half of the comparison and must not be dropped",
				chain, count["pump-fun-"+chain])
		}
	}
	if bridged == 0 {
		t.Error("no Pump Bridge row found in evmTerminals")
	}
}

// The dedupe guard must now drop nothing at all.
//
// It is kept because a collision is worse than a drop: two producers writing
// one series let the last tick win, silently. But after the route split no name
// is contested, so the guard should be inert. If it ever fires again this fails,
// and the fix is to name the new row for its route, not to let a row disappear.
func TestTheDedupeGuardDropsNothing(t *testing.T) {
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
			if relaySkips[c.slug] {
				continue
			}
			slug := a.Slug + "-" + c.slug
			if nativeOwnsSlug(slug) {
				t.Errorf("%s is claimed by evmTerminals as well; name the "+
					"native row for its route instead of dropping this one",
					slug)
			}
			if !got[slug] {
				t.Errorf("%s lost its row", slug)
			}
		}
	}
}
