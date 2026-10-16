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
}

func TestNonHeadlineSlicesDoNotClaimAll(t *testing.T) {
	// A second slice writing to `all` would overwrite the headline with
	// whichever profile ran last, which is the quiet version of the bug.
	for _, kind := range []string{"indexer", "trace", "simple-read", "solana-bot"} {
		if got := aliasesFor(kind, headlineKind); len(got) != 1 || got[0] != kind {
			t.Errorf("kind %q aliases = %v, want only itself", kind, got)
		}
	}
}

// The headline constant has to name a slice the harness actually produces,
// or the board pins a selector nothing writes to.
func TestHeadlineConstantsNameRealSlices(t *testing.T) {
	var kindFound bool
	for _, p := range Profiles {
		if p.ID == headlineKind {
			kindFound = true
		}
	}
	if !kindFound {
		t.Errorf("headlineKind %q matches no profile", headlineKind)
	}

	// Every workload the board offers has to resolve to exactly one chain,
	// or a query that does not pin chain matches two series and the scalar
	// read returns null. This is the shape that emptied the Solana tab: a
	// chain axis beside the workload axis offered cells no profile fills.
	chainOf := map[string]string{}
	for _, p := range Profiles {
		if prev, seen := chainOf[p.ID]; seen && prev != p.Chain {
			t.Errorf("profile %q exists on %s and %s; a workload must belong to one chain", p.ID, prev, p.Chain)
		}
		chainOf[p.ID] = p.Chain
	}
}
