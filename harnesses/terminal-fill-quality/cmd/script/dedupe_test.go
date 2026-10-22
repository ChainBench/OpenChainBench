package main

import (
	"strings"
	"testing"
)

// One fill must never be two rows.
//
// The route rename ended two producers owning one NAME. This is the same fault
// one level down: two producers owning one FILL. It cannot happen today, since
// only pump's relayers reach its routers, so this test exists to keep the
// guard honest rather than to catch a live bug.
func TestOneFillIsNeverPublishedTwice(t *testing.T) {
	// The same destination hash, recorded by both producers: the native
	// reader off the router, and the Relay feed as its request's out_tx.
	// Different case on purpose, because one comes from an API and one from
	// a receipt and nothing makes them agree.
	const h = "0xABCdef0000000000000000000000000000000000000000000000000000000001"
	swaps := []Swap{
		{Sig: h, Terminal: "pump-bridge-base"},
		{Sig: strings.ToLower(h), Terminal: "pump-fun-base", RelayID: "0xr1"},
		{Sig: "0xdeadbeef", Terminal: "fomo-base", RelayID: "0xr2"},
	}
	kept, dropped := dedupeAcrossProducers(swaps)

	if len(kept) != 2 {
		t.Fatalf("kept %d swaps, want 2", len(kept))
	}
	if dropped["pump-fun-base"] != 1 {
		t.Errorf("dropped = %v, want pump-fun-base counted once", dropped)
	}
	for _, s := range kept {
		if s.Terminal == "pump-fun-base" {
			t.Error("the Relay copy of a natively recorded fill survived")
		}
	}
	// An unrelated Relay swap must be untouched: the guard is narrow or it
	// would quietly delete the Relay rows it is meant to protect.
	seen := false
	for _, s := range kept {
		if s.Terminal == "fomo-base" {
			seen = true
		}
	}
	if !seen {
		t.Error("an unrelated Relay swap was dropped; the guard is too wide")
	}
}

// The native producer wins, not whichever was recorded first. Reversing the
// input order must not change the outcome, or the guard has reintroduced the
// arrival-order race the rename removed.
func TestNativeWinsWhateverTheOrder(t *testing.T) {
	const h = "0xfeed00000000000000000000000000000000000000000000000000000000beef"
	forward := []Swap{
		{Sig: h, Terminal: "pump-bridge-bnb"},
		{Sig: h, Terminal: "pump-fun-bnb", RelayID: "0xr"},
	}
	backward := []Swap{
		{Sig: h, Terminal: "pump-fun-bnb", RelayID: "0xr"},
		{Sig: h, Terminal: "pump-bridge-bnb"},
	}
	for name, in := range map[string][]Swap{"forward": forward, "backward": backward} {
		kept, _ := dedupeAcrossProducers(in)
		if len(kept) != 1 || kept[0].RelayID != "" {
			t.Errorf("%s: kept %d, want the native swap alone", name, len(kept))
		}
	}
}

// With no collision the window must come back whole. A guard that trims a
// window nobody contested would be far worse than the fault it prevents.
func TestNothingIsDroppedWhenProducersAreDisjoint(t *testing.T) {
	swaps := []Swap{
		{Sig: "0x01", Terminal: "pump-bridge-base"},
		{Sig: "0x02", Terminal: "pump-fun-base", RelayID: "0xr1"},
		{Sig: "0x03", Terminal: "fomo-robinhood", RelayID: "0xr2"},
		{Sig: "0x04", Terminal: "gmgn-bnb"},
	}
	kept, dropped := dedupeAcrossProducers(swaps)
	if len(kept) != len(swaps) {
		t.Errorf("kept %d of %d with no collision present", len(kept), len(swaps))
	}
	if dropped != nil {
		t.Errorf("dropped %v with no collision present", dropped)
	}
}
