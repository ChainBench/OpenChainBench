package main

import "testing"

// A fee nobody could measure must not be published as a fee of zero.
//
// Mobula's rail takes no app-fee transfer on either leg, but a fee the app
// sets and the bridge takes inside its quote leaves no transfer to find, so
// it sits in the bridge residual instead. mobula_price.go has said exactly
// that in a comment since the route shipped, and the column still printed 0
// next to FOMO's own Relay rows at 45 to 50 bps, because nothing downstream
// could tell "zero" from "unmeasured".
//
// Tested through c2field, the gate every aggregation goes through, so this
// checks the behaviour rather than the assignment.
func TestAnUnmeasurableTerminalFeeIsWithheldNotZeroed(t *testing.T) {
	measured := Swap{TerminalBps: 47.5}
	if v, ok := c2field(measured, "terminal"); !ok || v != 47.5 {
		t.Fatalf("a measured fee reported (%v, %v), want 47.5 and true", v, ok)
	}
	unknown := Swap{TerminalUnknown: true, TerminalBps: 0}
	v, ok := c2field(unknown, "terminal")
	if ok {
		t.Fatalf("an unmeasurable fee reported %v as a value; it must be withheld", v)
	}
	// Withheld is not the same as zero. A caller reading the value while
	// ignoring ok would publish "this route charges nothing", which is the
	// strongest possible claim about a fee nobody measured.
	if v != 0 {
		t.Fatalf("withheld terminal returned %v; callers must branch on ok", v)
	}
	// And a swap that genuinely paid nothing still reports it, because
	// "charged zero" is a real measurement and must stay distinguishable.
	free := Swap{TerminalBps: 0}
	if v, ok := c2field(free, "terminal"); !ok || v != 0 {
		t.Fatalf("a genuine zero reported (%v, %v); it must publish", v, ok)
	}
}

// The relay gate it mirrors must keep behaving the same way, so the two
// cannot drift apart.
func TestTerminalAndRelayGatesAgreeOnWithholding(t *testing.T) {
	for _, c := range []struct {
		name string
		s    Swap
		comp string
		want bool
	}{
		{"relay with an id", Swap{RelayID: "x", RelayBps: 75}, "relay", true},
		{"relay with no id", Swap{RelayBps: 75}, "relay", false},
		{"terminal measured", Swap{TerminalBps: 10}, "terminal", true},
		{"terminal unknown", Swap{TerminalUnknown: true}, "terminal", false},
	} {
		if _, ok := c2field(c.s, c.comp); ok != c.want {
			t.Errorf("%s: ok = %v, want %v", c.name, ok, c.want)
		}
	}
}
