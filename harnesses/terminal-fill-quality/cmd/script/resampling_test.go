package main

import "testing"

// A method bump re-samples a row exactly as a purge does, and until now only
// the purge branch said so. Every product was version-dropped by the v6 bump
// and none disclosed it, so the board ranked five products on about 3.2 h of
// samples under a label reading "rolling 24 h".
func TestAVersionDropMarksTheRowResampling(t *testing.T) {
	st := &State{
		Resampling: map[string]int64{},
		Swaps: []Swap{
			{Terminal: "axiom", Method: methodVersion, Sig: "keep"},
			{Terminal: "gmgn", Method: methodVersion - 1, Sig: "drop"},
		},
	}
	kept := []Swap{}
	now := int64(1_000_000)
	for _, sw := range st.Swaps {
		if sw.Method != methodVersion {
			st.Resampling[sw.Terminal] = now
			continue
		}
		kept = append(kept, sw)
	}
	if len(kept) != 1 || kept[0].Terminal != "axiom" {
		t.Fatalf("kept %v, want only the current-method row", kept)
	}
	if _, ok := st.Resampling["gmgn"]; !ok {
		t.Error("the dropped row's product was not marked re-sampling")
	}
	if _, ok := st.Resampling["axiom"]; ok {
		t.Error("a row that survived was marked re-sampling")
	}
}

// Rejects must be counted only from the window the surviving rows cover.
//
// A drop removes swaps and leaves the minute buckets, so unpriced_share
// divided a full day of rejects by whatever hours of rows survived. Nothing
// about pricing changed and Axiom BNB read 0.574 then 0.870.
func TestRejectsBeforeTheDropAreNotCounted(t *testing.T) {
	const drop = int64(2_000_000)
	buckets := []minuteBucket{
		{T: drop - 3600, Rej: map[string]int{"dust": 100}},
		{T: drop - 60, Rej: map[string]int{"dust": 50}},
		{T: drop, Rej: map[string]int{"dust": 7}},
		{T: drop + 600, Rej: map[string]int{"dust": 3}},
	}
	resampling := map[string]int64{"axiom-bnb": drop}

	count := func(slug string) int {
		n := 0
		for _, b := range buckets {
			if t0, ok := resampling[slug]; ok && b.T < t0 {
				continue
			}
			n += b.Rej["dust"]
		}
		return n
	}
	if got := count("axiom-bnb"); got != 10 {
		t.Fatalf("counted %d rejects for a re-sampling row, want 10 (the buckets at or after the drop)", got)
	}
	// A row that was never dropped keeps its whole window.
	if got := count("gmgn-bnb"); got != 160 {
		t.Fatalf("counted %d for an untouched row, want all 160", got)
	}
}
