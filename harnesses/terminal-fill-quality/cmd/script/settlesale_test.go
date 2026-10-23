package main

import "testing"

// The mirror of TestOnlySolanaOriginRequestsAreTimed. That test guards the
// buy path against picking up sales; this one guards the sale path against
// picking up buys. Together they say the two directions never overlap, which
// is what lets both share one dedupe map.
func TestOnlyEvmOriginRequestsAreTimedAsSales(t *testing.T) {
	sample := []relayRequest{
		{ID: "buy", DestChain: "bnb", Chain: "solana", InTx: "sol1", OutTx: "0x1"},
		{ID: "sale", DestChain: "", Chain: "bnb", InTx: "0xa", OutTx: "sig"},
	}
	got := settleXchainSaleTodo(sample, map[string]bool{}, 10)
	if len(got) != 1 || got[0].ID != "sale" {
		t.Fatalf("picked %v, want only the EVM-origin sale", idsOf(got))
	}
	// And the buy picker must still refuse that same sale, or one leg would
	// be timed twice under two different chain labels.
	buys := settleXchainTodo(sample, map[string]bool{}, 10)
	if len(buys) != 1 || buys[0].ID != "buy" {
		t.Fatalf("buy picker took %v, want only the Solana-origin buy", idsOf(buys))
	}
}

// The direction is read off the shape of the two hashes, because the feed has
// no field that says "sale". A leg whose output is 0x went to an EVM chain
// and is not ours to time here, whatever its DestChain happens to say.
func TestSaleLegIsRecognisedByHashShapeNotByLabel(t *testing.T) {
	cases := []struct {
		name string
		x    relayRequest
		want bool
	}{
		{"evm in, solana out", relayRequest{Chain: "bnb", InTx: "0xa", OutTx: "sig"}, true},
		{"evm in, evm out", relayRequest{Chain: "bnb", InTx: "0xa", OutTx: "0xb"}, false},
		{"solana in, solana out", relayRequest{Chain: "solana", InTx: "s1", OutTx: "s2"}, false},
		{"solana origin chain", relayRequest{Chain: "solana", InTx: "0xa", OutTx: "sig"}, false},
		{"has a dest chain", relayRequest{Chain: "bnb", DestChain: "base", InTx: "0xa", OutTx: "sig"}, false},
		{"missing output", relayRequest{Chain: "bnb", InTx: "0xa", OutTx: ""}, false},
		{"missing input", relayRequest{Chain: "bnb", InTx: "", OutTx: "sig"}, false},
		{"chain we do not read", relayRequest{Chain: "a-chain-we-do-not-read", InTx: "0xa", OutTx: "sig"}, false},
	}
	for _, c := range cases {
		if _, ok := saleLeg(c.x); ok != c.want {
			t.Errorf("%s: saleLeg = %v, want %v", c.name, ok, c.want)
		}
	}
}

// A leg already timed must not be drawn again. The Relay feed re-walks its
// requests after a restart, and the same leg timed twice would inflate the
// sample behind a published mean while looking like more data.
func TestTimedSaleLegsAreNotDrawnTwice(t *testing.T) {
	sample := []relayRequest{
		{ID: "a", Chain: "bnb", InTx: "0xa", OutTx: "s1"},
		{ID: "b", Chain: "base", InTx: "0xb", OutTx: "s2"},
	}
	done := map[string]bool{}
	first := settleXchainSaleTodo(sample, done, 10)
	if len(first) != 2 {
		t.Fatalf("first pass picked %d, want 2", len(first))
	}
	for _, x := range first {
		done[x.ID] = true
	}
	if second := settleXchainSaleTodo(sample, done, 10); len(second) != 0 {
		t.Fatalf("second pass picked %d of the same legs; they would be counted twice", len(second))
	}
}

// The per-tick bound must hold on this path too, so one busy app cannot take
// the whole read budget from the rest of the board.
func TestSaleTodoRespectsTheLimit(t *testing.T) {
	var sample []relayRequest
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		sample = append(sample, relayRequest{ID: id, Chain: "bnb", InTx: "0x" + id, OutTx: "s" + id})
	}
	if got := settleXchainSaleTodo(sample, map[string]bool{}, 2); len(got) != 2 {
		t.Fatalf("picked %d with a limit of 2", len(got))
	}
}
