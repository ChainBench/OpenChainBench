package main

import "testing"

// A request must be timed once, however often the feed re-walks it.
//
// The Relay feed re-reads requests after a restart, and this harness restarted
// about eight times in one evening. A request timed twice would inflate the
// sample behind a published mean while looking like more data, which is the
// same defect as the fill watcher re-reading its block range.
func TestASettledRequestIsNotTimedTwice(t *testing.T) {
	sample := []relayRequest{
		{ID: "a", DestChain: "bnb", InTx: "sol1", OutTx: "0x1"},
		{ID: "b", DestChain: "base", InTx: "sol2", OutTx: "0x2"},
	}
	done := map[string]bool{}
	first := settleXchainTodo(sample, done, 10)
	if len(first) != 2 {
		t.Fatalf("first pass picked %d, want 2", len(first))
	}
	for _, x := range first {
		done[x.ID] = true
	}
	if second := settleXchainTodo(sample, done, 10); len(second) != 0 {
		t.Fatalf("second pass picked %d of the same requests; they would be counted twice", len(second))
	}
}

// Only Solana-origin requests are timed here. The sale direction needs a
// different pair of reads, and timing it with these would compare an EVM
// block against an EVM block and publish a number that is not a settlement.
func TestOnlySolanaOriginRequestsAreTimed(t *testing.T) {
	sample := []relayRequest{
		{ID: "buy", DestChain: "bnb", InTx: "sol1", OutTx: "0x1"},
		{ID: "sale", DestChain: "", Chain: "bnb", InTx: "0xa", OutTx: "sig"},
	}
	got := settleXchainTodo(sample, map[string]bool{}, 10)
	if len(got) != 1 || got[0].ID != "buy" {
		t.Fatalf("picked %v, want only the Solana-origin request", idsOf(got))
	}
}

// A request missing either hash, or bound for a chain this bench cannot read,
// must be skipped rather than attempted: a failed read costs the budget and
// teaches nothing.
func TestIncompleteOrUnreadableRequestsAreSkipped(t *testing.T) {
	sample := []relayRequest{
		{ID: "noin", DestChain: "bnb", InTx: "", OutTx: "0x1"},
		{ID: "noout", DestChain: "bnb", InTx: "sol", OutTx: ""},
		{ID: "nochain", DestChain: "a-chain-we-do-not-read", InTx: "sol", OutTx: "0x1"},
		{ID: "good", DestChain: "base", InTx: "sol", OutTx: "0x2"},
	}
	got := settleXchainTodo(sample, map[string]bool{}, 10)
	if len(got) != 1 || got[0].ID != "good" {
		t.Fatalf("picked %v, want only the complete readable request", idsOf(got))
	}
}

// The per-tick bound must hold, so a busy app cannot take the whole budget
// from the rest of the board.
func TestTimingIsBoundedPerTick(t *testing.T) {
	var sample []relayRequest
	for i := 0; i < settleXchainPerTick*3; i++ {
		sample = append(sample, relayRequest{ID: string(rune('a'+i%26)) + fillHash(i), DestChain: "bnb", InTx: "sol", OutTx: "0x1"})
	}
	got := settleXchainTodo(sample, map[string]bool{}, settleXchainPerTick)
	if len(got) != settleXchainPerTick {
		t.Fatalf("picked %d with a bound of %d", len(got), settleXchainPerTick)
	}
}

// And the bound must be well above the pricing quota, because that coupling
// is the whole bug: timing needs two block timestamps and pricing needs a
// dozen reads, so binding the cheap measurement to the expensive one's budget
// left FOMO at 8 settlements while its feed saw thousands of requests.
func TestTimingBudgetIsNotThePricingQuota(t *testing.T) {
	if settleXchainPerTick < 20 {
		t.Fatalf("settleXchainPerTick is %d, which is close enough to the pricing quota to reintroduce the coupling this fixes", settleXchainPerTick)
	}
}

func idsOf(rs []relayRequest) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.ID)
	}
	return out
}
