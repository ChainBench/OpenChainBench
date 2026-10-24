package main

import "testing"

// The flow tally must count each paired fill once, per app and per chain,
// and hand the interval over on drain.
//
// Without it sampleMobula recorded no attempts at all, attOf stayed 0 on
// every Mobula row, and the pooled split fell back to one weight per swap.
// That weights a product by how much of each chain we sampled rather than
// by how much its users traded: the sample ran BNB 54 % and Robinhood 40 %
// while the rail's own fills ran Robinhood 23 of 29.
func TestMobulaFlowTallyCountsPerAppAndChain(t *testing.T) {
	mobulaDrainSeen() // start from a known empty state

	for i := 0; i < 23; i++ {
		mobulaNoteSeen("fomo-mobula", "robinhood")
	}
	for i := 0; i < 2; i++ {
		mobulaNoteSeen("fomo-mobula", "bnb")
	}
	mobulaNoteSeen("other-mobula", "bnb")

	got := mobulaDrainSeen()
	if n := got[[2]string{"fomo-mobula", "robinhood"}]; n != 23 {
		t.Errorf("robinhood tallied %d, want 23", n)
	}
	if n := got[[2]string{"fomo-mobula", "bnb"}]; n != 2 {
		t.Errorf("bnb tallied %d, want 2", n)
	}
	// Another integrator on the same rail must not join FOMO's row.
	if n := got[[2]string{"other-mobula", "bnb"}]; n != 1 {
		t.Errorf("a second app tallied %d under its own key, want 1", n)
	}
	if len(got) != 3 {
		t.Errorf("tally holds %d keys, want 3", len(got))
	}
}

// Drain must hand over an interval, not a running total: a tick that
// recorded its count and then saw nothing must record nothing, or the
// attempts would compound every minute.
func TestMobulaFlowTallyDrainsToEmpty(t *testing.T) {
	mobulaDrainSeen()
	mobulaNoteSeen("fomo-mobula", "base")
	if n := mobulaDrainSeen()[[2]string{"fomo-mobula", "base"}]; n != 1 {
		t.Fatalf("first drain gave %d, want 1", n)
	}
	if got := mobulaDrainSeen(); len(got) != 0 {
		t.Fatalf("second drain gave %v, want empty", got)
	}
}

// Incomplete entries are refused, because a blank app or chain would record
// attempts against a slug like "-bnb" that no row owns.
func TestMobulaFlowTallyRefusesBlanks(t *testing.T) {
	mobulaDrainSeen()
	mobulaNoteSeen("", "bnb")
	mobulaNoteSeen("fomo-mobula", "")
	mobulaNoteSeen("", "")
	if got := mobulaDrainSeen(); len(got) != 0 {
		t.Fatalf("blanks were tallied: %v", got)
	}
}
