package main

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestQuorumHash(t *testing.T) {
	cases := []struct {
		name  string
		votes map[string]string
		want  string
	}{
		{"empty", map[string]string{}, ""},
		{"single vote no quorum", map[string]string{"a": "0xaa"}, ""},
		{"two agree", map[string]string{"a": "0xaa", "b": "0xaa"}, "0xaa"},
		{"majority beats minority", map[string]string{"a": "0xaa", "b": "0xaa", "c": "0xbb"}, "0xaa"},
		{"reorg 2-2 split counts nobody", map[string]string{"a": "0xaa", "b": "0xaa", "c": "0xbb", "d": "0xbb"}, ""},
		{"3-2 split resolves", map[string]string{"a": "0xaa", "b": "0xaa", "c": "0xaa", "d": "0xbb", "e": "0xbb"}, "0xaa"},
		{"all distinct", map[string]string{"a": "0xaa", "b": "0xbb", "c": "0xcc"}, ""},
	}
	for _, tc := range cases {
		if got := quorumHash(tc.votes); got != tc.want {
			t.Errorf("%s: quorumHash = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestObserveFlagsMinorityOnce(t *testing.T) {
	tr := newConsensusTracker()
	chain := "testchain-mismatch"
	tips.update(chain, 100)

	mismatches := func(p string) float64 {
		return testutil.ToFloat64(rpcHashMismatch.WithLabelValues(p, chain, currentRegion))
	}

	// First vote: no quorum yet, nobody flagged.
	tr.observe(chain, "alpha", 100, "0xaa")
	if got := mismatches("alpha"); got != 0 {
		t.Fatalf("alpha flagged before any quorum existed: %v", got)
	}

	// Quorum forms on 0xaa; gamma disagrees and is flagged exactly once.
	tr.observe(chain, "beta", 100, "0xaa")
	tr.observe(chain, "gamma", 100, "0xbb")
	if got := mismatches("gamma"); got != 1 {
		t.Fatalf("gamma mismatch count = %v, want 1", got)
	}
	if mismatches("alpha") != 0 || mismatches("beta") != 0 {
		t.Fatalf("quorum members were flagged")
	}

	// Re-reporting the same bad hash at the same height must not
	// double-count: 60s probes revisit heights on slow chains.
	tr.observe(chain, "gamma", 100, "0xbb")
	if got := mismatches("gamma"); got != 1 {
		t.Fatalf("gamma double-counted at same height: %v", got)
	}

	// A different height is a new incident.
	tr.observe(chain, "alpha", 101, "0xcc")
	tr.observe(chain, "beta", 101, "0xcc")
	tr.observe(chain, "gamma", 101, "0xdd")
	if got := mismatches("gamma"); got != 2 {
		t.Fatalf("gamma mismatch count after 2nd height = %v, want 2", got)
	}
}

func TestObserveReorgSplitCountsNobody(t *testing.T) {
	tr := newConsensusTracker()
	chain := "testchain-reorg"
	tips.update(chain, 50)

	tr.observe(chain, "a", 50, "0xaa")
	tr.observe(chain, "b", 50, "0xaa")
	tr.observe(chain, "c", 50, "0xbb")
	tr.observe(chain, "d", 50, "0xbb")
	// c was flagged while 0xaa held a 2-1 plurality; d's vote made it
	// 2-2, and from that point no NEW flags may appear.
	before := testutil.ToFloat64(rpcHashMismatch.WithLabelValues("d", chain, currentRegion))
	if before != 0 {
		t.Fatalf("d flagged on a 2-2 split: %v", before)
	}
}

func TestObserveConsensusLagGauge(t *testing.T) {
	tr := newConsensusTracker()
	chain := "testchain-lag"
	tips.update(chain, 200)

	tr.observe(chain, "laggy", 197, "0xaa")
	got := testutil.ToFloat64(rpcConsensusLag.WithLabelValues("laggy", chain, currentRegion))
	if got != 3 {
		t.Fatalf("lag gauge = %v, want 3", got)
	}

	// Provider at (or ahead of) the recorded tip reads 0.
	tr.observe(chain, "fresh", 200, "0xaa")
	if got := testutil.ToFloat64(rpcConsensusLag.WithLabelValues("fresh", chain, currentRegion)); got != 0 {
		t.Fatalf("fresh lag gauge = %v, want 0", got)
	}

	// Solana path: empty hash emits lag but never votes.
	tr.observe(chain, "solananode", 195, "")
	if got := testutil.ToFloat64(rpcConsensusLag.WithLabelValues("solananode", chain, currentRegion)); got != 5 {
		t.Fatalf("solana lag gauge = %v, want 5", got)
	}
	if got := testutil.ToFloat64(rpcHashMismatch.WithLabelValues("solananode", chain, currentRegion)); got != 0 {
		t.Fatalf("hashless observation voted: %v", got)
	}
}

func TestConsensusPruning(t *testing.T) {
	tr := newConsensusTracker()
	chain := "testchain-prune"
	tips.update(chain, 10)

	tr.observe(chain, "a", 10, "0xaa")
	tips.update(chain, 10+consensusPruneDepth+5)
	tr.observe(chain, "a", 10+consensusPruneDepth+5, "0xbb")

	tr.mu.Lock()
	defer tr.mu.Unlock()
	if _, ok := tr.chains[chain].heights[10]; ok {
		t.Fatalf("height 10 not pruned at tip %d", 10+consensusPruneDepth+5)
	}
}

func TestMajority(t *testing.T) {
	if v, ok := majority(map[int]int{1371: 3, 1370: 1}); !ok || v != 1371 {
		t.Fatalf("majority(3-1) = %v %v", v, ok)
	}
	if _, ok := majority(map[int]int{1371: 2, 1370: 2}); ok {
		t.Fatalf("tie must not resolve")
	}
	if _, ok := majority(map[int]int{1371: 1}); ok {
		t.Fatalf("single answer must not resolve")
	}
	if v, ok := majority(map[string]int{"0x1": 2}); !ok || v != "0x1" {
		t.Fatalf("majority(2-0) = %v %v", v, ok)
	}
}
