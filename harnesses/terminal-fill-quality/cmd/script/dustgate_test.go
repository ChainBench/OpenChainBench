package main

import (
	"strings"
	"testing"
)

// The dust gate drops events before they are ever counted or sampled, so a
// misread word does not produce a wrong number, it produces a missing one.
// Nothing downstream can notice. These pin the two things that would make it
// silent: the word it reads, and which rows are allowed to read one at all.

func TestLogWordUSDReadsTheDeclaredWord(t *testing.T) {
	// Three words: a zero, a zero, then 0.149500 at six decimals (149500),
	// which is the shape and the size of the dust actually on chain.
	const amt = "247fc" // 149500 = 0.149500 at six decimals
	data := "0x" + strings.Repeat("0", 64) + strings.Repeat("0", 64) +
		strings.Repeat("0", 64-len(amt)) + amt
	got, ok := logWordUSD(data, 2, 6)
	if !ok {
		t.Fatal("word 2 of a three-word payload should be readable")
	}
	if got < 0.1494 || got > 0.1496 {
		t.Errorf("read %.6f, want 0.1495", got)
	}
	if got >= minTradeUSD {
		t.Errorf("0.1495 must fall under the %.2f floor or the gate does nothing", minTradeUSD)
	}
}

// A payload that no longer holds the word must stop the filter, not make it
// guess. Returning a zero here would read as "below the floor" and silently
// drop every swap on the row.
func TestLogWordUSDRefusesShortData(t *testing.T) {
	for _, d := range []string{"", "0x", "0x00", "0x" + strings.Repeat("0", 64)} {
		if v, ok := logWordUSD(d, 2, 6); ok {
			t.Errorf("data %q: returned %v, want refusal", d, v)
		}
	}
}

// Only a row whose layout was checked against the chain may filter, and its
// decimals must be the decimals of the token it settles in. Getting the
// decimals wrong by three would put every real trade under the floor and empty
// the row without any error.
func TestOnlyVerifiedRowsDeclareASizeWord(t *testing.T) {
	declared := 0
	for _, e := range evmTerminals {
		if len(e.SizeWord) == 0 {
			if e.SizeDec != 0 {
				t.Errorf("%s declares SizeDec with no SizeWord", e.Slug)
			}
			continue
		}
		declared++
		if e.Slug != "pump-bridge-robinhood" {
			t.Errorf("%s declares a size word; only rows whose layout has been "+
				"checked against the chain may, and only Robinhood Chain has "+
				"been", e.Slug)
		}
		// The decimals must match the stable this row actually settles in.
		stable := pumpStableOf(e.Slug)
		if stable == "" {
			t.Errorf("%s declares a size word but no settlement stable", e.Slug)
			continue
		}
		for _, r := range pumpRouters {
			if r.chain == e.Chain && r.decimals != e.SizeDec {
				t.Errorf("%s: SizeDec %d but the watcher reads %s at %d decimals",
					e.Slug, e.SizeDec, r.symbol, r.decimals)
			}
		}
		for sig := range e.SizeWord {
			if !strings.HasPrefix(sig, "0x") || len(sig) != 66 {
				t.Errorf("%s: %q is not an event signature", e.Slug, sig)
			}
		}
	}
	if declared == 0 {
		t.Error("no row declares a size word, so the dust gate is dead code")
	}
}
