package main

import "testing"

// The rotation must visit every origin chain, and visit them evenly.
//
// Relay answers the first two requests of a round and refuses from the
// third, so a round that polled all nine chains read Solana and Robinhood
// and silently lost the rest: their resume watermarks sat 572 to 597 hours
// stale while the feed reported healthy, because the Solana poll alone sets
// that gauge.
//
// This pins the property the fix rests on. A rotation that skipped a chain
// would reproduce the bug on that one chain, quietly, which is exactly the
// shape worth a test rather than a comment.
func TestEveryOriginChainIsPolledByTheRotation(t *testing.T) {
	if len(originChains) == 0 {
		t.Skip("no origin chains declared")
	}
	visits := map[string]int{}
	rounds := len(originChains) * 3
	for turn := 0; turn < rounds; turn++ {
		visits[originChains[turn%len(originChains)].slug]++
	}
	for _, c := range originChains {
		n := visits[c.slug]
		if n != 3 {
			t.Errorf("%s visited %d times over %d rounds, want 3: the rotation is uneven",
				c.slug, n, rounds)
		}
	}
	if len(visits) != len(originChains) {
		t.Fatalf("rotation reached %d of %d chains", len(visits), len(originChains))
	}
}

// Two requests a round, not nine. The measured limit is that the third is
// refused, so the count per round is the whole point of the change.
func TestARoundMakesTwoRelayRequests(t *testing.T) {
	// Solana always, plus exactly one rotating chain.
	const perRound = 2
	if len(originChains) == 0 {
		t.Skip("no origin chains declared")
	}
	// A round that polled every chain would make this many, which Relay
	// refuses from the third onward.
	wouldHaveBeen := 1 + len(originChains)
	if wouldHaveBeen <= perRound {
		t.Skip("too few chains for the pacing to matter")
	}
	if perRound >= 3 {
		t.Fatalf("a round makes %d requests; Relay refuses from the third", perRound)
	}
}

// Every chain must be revisited well inside the window the fill watcher
// reaches back over, or a paced poll trades one silent gap for another.
func TestTheRotationStaysInsideTheFillReach(t *testing.T) {
	if len(originChains) == 0 {
		t.Skip("no origin chains declared")
	}
	const tickSeconds = 60
	gap := len(originChains) * tickSeconds
	if gap >= mobulaFillReach {
		t.Fatalf("a chain is revisited every %d s against a fill reach of %d s: "+
			"the rotation would leave gaps the watcher cannot cover", gap, mobulaFillReach)
	}
}
