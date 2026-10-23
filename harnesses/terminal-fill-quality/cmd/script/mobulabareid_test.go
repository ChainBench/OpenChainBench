package main

import "testing"

// The bare-id reader must accept exactly the shape every observed intent id
// has and refuse everything else.
//
// Why strictness is the whole point: the memo program is public and carries
// whatever any integrator writes, so an accepting reader would turn a stray
// human note into an intent id and then into a settlement measured against an
// unrelated transaction. A loose matcher on this rail already produced a
// false "10 of 10" once by hitting three-character fragments; the strict one
// gave 4 of 10, which was the truth.
func TestBareIntentIDIsMatchedOnShapeAlone(t *testing.T) {
	good := []string{
		"5194d07-33b0871-3b8", "fc7be5f-479bcdd-745",
		"d8df279-3c374d5-9f7", "5976756-d392c16-095",
	}
	for _, s := range good {
		if !mobulaBareIntentID(s) {
			t.Errorf("%q is a real intent id and was refused", s)
		}
	}
	bad := []string{
		"", "-", "gm", "hello world",
		"5194d07-33b0871",           // two groups
		"5194d07-33b0871-3b8-extra", // four groups
		"5194d0-33b0871-3b8",        // first group short
		"5194d07-33b0871-3b",        // last group short
		"5194D07-33b0871-3b8",       // uppercase is not what is written
		"5194z07-33b0871-3b8",       // not hex
		"thanks for the trade, anon",
		`{"intentId":"5194d07-33b0871-3b8"}`, // the JSON form is the other reader's
	}
	for _, s := range bad {
		if mobulaBareIntentID(s) {
			t.Errorf("%q is not an intent id and was accepted", s)
		}
	}
}
