package main

import "testing"

func TestFairQueueRoundRobin(t *testing.T) {
	f := newFairQueue(100)
	for i := 0; i < 50; i++ {
		f.push(TokenToCheck{ChainID: "solana:solana"})
	}
	f.push(TokenToCheck{ChainID: "evm:8453", Address: "b"})
	f.push(TokenToCheck{ChainID: "evm:4663", Address: "r"})
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		tok, ok := f.tryPop()
		if !ok {
			t.Fatal("empty")
		}
		seen[tok.ChainID] = true
	}
	// A Solana burst must not keep Base or Robinhood waiting behind it.
	if !seen["evm:8453"] || !seen["evm:4663"] {
		t.Fatalf("first three pops %v, want Base and Robinhood among them", seen)
	}
}

func TestFairQueueDropsOldest(t *testing.T) {
	f := newFairQueue(2)
	f.push(TokenToCheck{ChainID: "c", Address: "1"})
	f.push(TokenToCheck{ChainID: "c", Address: "2"})
	if !f.push(TokenToCheck{ChainID: "c", Address: "3"}) {
		t.Fatal("expected a drop")
	}
	a, _ := f.tryPop()
	b, _ := f.tryPop()
	if a.Address != "2" || b.Address != "3" {
		t.Fatalf("got %s,%s, want 2,3", a.Address, b.Address)
	}
}
