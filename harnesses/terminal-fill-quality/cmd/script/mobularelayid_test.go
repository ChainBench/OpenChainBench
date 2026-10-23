package main

import "testing"

// A Mobula row must carry the intent id in RelayID, or its bridge take is
// computed and then thrown away.
//
// The component aggregations gather a rail's cut only when RelayID is set.
// With it empty the residual survived in the per-swap record and in nothing
// a reader sees: a median take of 75.2 bps, 38% of the row's median loss,
// appeared in no column while the terminal column read 0. The route
// advertised a zero fee and hid the charge at the same time.
//
// c2field is the gate itself, so this tests the behaviour rather than
// the assignment: a row with the id reports its relay component, one without
// reports nothing, and "nothing" must not be mistaken for zero.
func TestMobulaRowPublishesItsBridgeTakeOnlyWithAnIntentID(t *testing.T) {
	withID := Swap{RelayID: "5976756-d392c16-095", RelayBps: 75.2}
	if v, ok := c2field(withID, "relay"); !ok || v != 75.2 {
		t.Fatalf("a row carrying its intent id reported relay = %v (ok=%v), want 75.2", v, ok)
	}
	withoutID := Swap{RelayID: "", RelayBps: 75.2}
	v, ok := c2field(withoutID, "relay")
	if ok {
		t.Fatalf("a row with no intent id reported relay = %v; the take must be withheld, not published", v)
	}
	// And withheld is not zero: a caller that reads the value while ignoring
	// ok would publish a charge of nothing on a route that charges 75 bps.
	if v != 0 || ok {
		t.Fatalf("withheld relay returned (%v, %v); callers must branch on ok", v, ok)
	}
}
