package main

import "testing"

// The free-tier board (bench 283) pins kind="all" and chain="all" in every
// query. injectLabels only replaces a selector pinned to `="all"`, so without
// these aliases a reader switching tabs changes nothing and the default view
// spans every combination instead of one slice: providers then appear several
// times with different allowances and the table reads as noise.
//
// `all` is the headline slice and not a pooled average on purpose. An
// allowance expressed in requests depends on what one request costs in units,
// so averaging a dapp mix with a trace mix would describe no workload anyone
// runs. The dimension labels name the slice each `all` carries.
func TestFreeAllowancePublishesHeadlineUnderAll(t *testing.T) {
	if got := aliasesFor(headlineKind, headlineKind); len(got) != 2 || got[1] != "all" {
		t.Errorf("headline kind %q aliases = %v, want it published under its own name and under all", headlineKind, got)
	}
	if got := aliasesFor(headlineChain, headlineChain); len(got) != 2 || got[1] != "all" {
		t.Errorf("headline chain %q aliases = %v, want it published under its own name and under all", headlineChain, got)
	}
}

func TestNonHeadlineSlicesDoNotClaimAll(t *testing.T) {
	// A second slice writing to `all` would overwrite the headline with
	// whichever profile ran last, which is the quiet version of the bug.
	for _, kind := range []string{"indexer", "trace", "simple-read", "solana-bot"} {
		if got := aliasesFor(kind, headlineKind); len(got) != 1 || got[0] != kind {
			t.Errorf("kind %q aliases = %v, want only itself", kind, got)
		}
	}
	if got := aliasesFor("solana", headlineChain); len(got) != 1 || got[0] != "solana" {
		t.Errorf("chain solana aliases = %v, want only itself", got)
	}
}

// Both headline constants have to name slices the harness actually produces,
// or the board pins a selector nothing writes to.
func TestHeadlineConstantsNameRealSlices(t *testing.T) {
	var kindFound, chainFound bool
	for _, p := range Profiles {
		if p.ID == headlineKind {
			kindFound = true
		}
		if p.Chain == headlineChain {
			chainFound = true
		}
	}
	if !kindFound {
		t.Errorf("headlineKind %q matches no profile", headlineKind)
	}
	if !chainFound {
		t.Errorf("headlineChain %q matches no profile chain", headlineChain)
	}
}
