package main

import (
	"testing"
	"time"
)

// race.go had no test file, which is how the First to report panel published
// OKX at 95.93% on Solana for a day. Every assertion here is one that would
// have failed on that code.

func newTestBook() *raceBook {
	return &raceBook{
		entries:      map[string]*raceEntry{},
		history:      map[string][]raceResult{},
		participants: map[string]map[string]bool{},
	}
}

// withPoolTrades swaps the membership set for the duration of a test and
// restores it, so tests do not leak into each other or into the live set.
func withPoolTrades(t *testing.T, observe func(p *refClock)) {
	t.Helper()
	saved := poolTrades
	poolTrades = &refClock{seen: map[string]refEntry{}}
	observe(poolTrades)
	t.Cleanup(func() { poolTrades = saved })
}

// A trade no pool subscription saw is not this bench's race.
//
// This is the defect: OKX and Birdeye are subscribed per token, so they both
// report trades from pools the bench does not measure. Those arrive as a
// two-participant race and used to be scored, handing a first to whichever of
// the two is quicker and inflating the denominator of every pool-scoped feed.
func TestRaceVoidsTradesOutsideTheBenchPool(t *testing.T) {
	withPoolTrades(t, func(p *refClock) {}) // the pool saw nothing

	b := newTestBook()
	now := time.Now()
	b.observe("okx", "solana", "eu-west", "OFFPOOLHASH", now, 0)
	b.observe("birdeye", "solana", "eu-west", "OFFPOOLHASH", now.Add(200*time.Millisecond), 0)

	b.resolve(now.Add(raceWindow + time.Second))

	e := b.entries[raceKey("solana", "eu-west", "OFFPOOLHASH")]
	if e == nil {
		t.Fatal("race entry vanished")
	}
	if !e.closed {
		t.Error("race should be closed after the window")
	}
	if !e.void {
		t.Fatal("a trade outside the bench pool was scored as a race; that is " +
			"what gave OKX 75,151 firsts an hour on 1,210 pool trades")
	}
	if len(b.history[("solana|eu-west")]) != 0 {
		t.Error("an off-pool race entered the share history, so it sits in " +
			"every pool-scoped feed's denominator")
	}
}

// The companion assertion: a genuine pool trade is still scored, and the
// earliest feed still wins it. Without this, voiding everything would pass
// the test above and publish nothing.
func TestRaceScoresTradesInsideTheBenchPool(t *testing.T) {
	withPoolTrades(t, func(p *refClock) {
		p.observe("solana", "POOLHASH", time.Now())
	})

	b := newTestBook()
	now := time.Now()
	b.observe("mobula", "solana", "eu-west", "POOLHASH", now, 0)
	b.observe("okx", "solana", "eu-west", "POOLHASH", now.Add(200*time.Millisecond), 0)

	b.resolve(now.Add(raceWindow + time.Second))

	e := b.entries[raceKey("solana", "eu-west", "POOLHASH")]
	if e == nil || !e.closed {
		t.Fatal("pool race did not close")
	}
	if e.void {
		t.Fatal("a bench-pool trade was voided; the panel would publish nothing")
	}
	hist := b.history["solana|eu-west"]
	if len(hist) != 1 {
		t.Fatalf("history has %d races, want 1", len(hist))
	}
	if len(hist[0].winners) != 1 || hist[0].winners[0] != "mobula" {
		t.Errorf("winners = %v, want [mobula]: it arrived 200 ms earlier",
			hist[0].winners)
	}
}

// A chain where we hold no pool subscription must not be silenced. Robinhood
// has no endpoint we trust, and voiding every race there would read on the
// page exactly like four dead feeds.
func TestRaceStillScoresChainsWithNoPoolSubscription(t *testing.T) {
	if benchPoolScoped("robinhood") {
		t.Skip("robinhood gained a reference endpoint; this test needs rewriting")
	}
	withPoolTrades(t, func(p *refClock) {}) // nothing, and it must not matter

	b := newTestBook()
	now := time.Now()
	b.observe("mobula", "robinhood", "eu-west", "RHHASH", now, 0)
	b.observe("codex", "robinhood", "eu-west", "RHHASH", now.Add(50*time.Millisecond), 0)

	b.resolve(now.Add(raceWindow + time.Second))

	e := b.entries[raceKey("robinhood", "eu-west", "RHHASH")]
	if e == nil || !e.closed {
		t.Fatal("robinhood race did not close")
	}
	if e.void {
		t.Fatal("a chain with no pool subscription was voided, which publishes " +
			"its feeds as silent rather than unmeasured")
	}
}

// The membership test must read poolTrades and not `reference`. On Base the
// reference is the chain-wide flashblock stream, so it matches every
// transaction on the chain and cannot tell a pool trade from any other. A
// future refactor that "simplifies" this back to reference.lookup would
// restore the bug on Base while Solana kept passing.
func TestRaceMembershipDoesNotUseTheChainWideReference(t *testing.T) {
	savedRef := reference
	reference = &refClock{seen: map[string]refEntry{}}
	// Exactly what base_flashblock_ref.go does for every Base transaction.
	reference.observe("base", "ANYBASETX", time.Now())
	t.Cleanup(func() { reference = savedRef })

	withPoolTrades(t, func(p *refClock) {}) // but the pool never saw it

	b := newTestBook()
	now := time.Now()
	b.observe("okx", "base", "eu-west", "ANYBASETX", now, 0)
	b.observe("birdeye", "base", "eu-west", "ANYBASETX", now.Add(300*time.Millisecond), 0)

	b.resolve(now.Add(raceWindow + time.Second))

	e := b.entries[raceKey("base", "eu-west", "ANYBASETX")]
	if e == nil || !e.closed {
		t.Fatal("base race did not close")
	}
	if !e.void {
		t.Fatal("an off-pool Base trade was scored because the chain-wide " +
			"flashblock reference knows every transaction. Membership must " +
			"come from poolTrades.")
	}
}

// Both token-scoped providers must be in the map the pending resolver uses,
// since their off-pool emissions are expected misses rather than failures.
// Stated here too because the two behaviours have to stay in step: a provider
// exempt from the miss counter is exactly one whose races need pool filtering.
func TestTokenScopedProvidersAreTheOnesNeedingPoolFiltering(t *testing.T) {
	for _, a := range []string{"okx", "birdeye"} {
		if !tokenScopedAggregators[a] {
			t.Errorf("%s is subscribed per token but is not in "+
				"tokenScopedAggregators, so its off-pool emissions count as "+
				"reference misses", a)
		}
	}
	for _, a := range []string{"mobula", "codex", "serialized", "geckoterminal"} {
		if tokenScopedAggregators[a] {
			t.Errorf("%s is pool-scoped; exempting it hides real misses", a)
		}
	}
}

// A trade one feed alone reported must not award it a first.
//
// The counter used to be incremented inside the winners loop, which runs
// before the single-participant return, so such a trade handed that feed a
// first while never entering the race count or the share history. A numerator
// moving without its denominator is the same defect that published OKX at
// 95.93% on Solana, and it survived the first fix.
func TestSingleProviderRaceAwardsNoFirst(t *testing.T) {
	withPoolTrades(t, func(p *refClock) {
		p.observe("solana", "LONEHASH", time.Now())
	})
	// A reference observation makes len(obs) == 2, so the race passes the
	// participant guard and reaches the providers < 2 return. That is exactly
	// the path that used to award the free first.
	savedRef := reference
	reference = &refClock{seen: map[string]refEntry{}}
	reference.observe("solana", "LONEHASH", time.Now())
	t.Cleanup(func() { reference = savedRef })

	b := newTestBook()
	now := time.Now()
	b.observe("okx", "solana", "eu-west", "LONEHASH", now, 0)

	b.resolve(now.Add(raceWindow + time.Second))

	e := b.entries[raceKey("solana", "eu-west", "LONEHASH")]
	if e == nil || !e.closed {
		t.Fatal("race did not close")
	}
	if len(b.history["solana|eu-west"]) != 0 {
		t.Error("a single-provider race entered the share history, so it would " +
			"sit in every other feed's denominator")
	}
}
