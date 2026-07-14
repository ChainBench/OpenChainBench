package main

import "sync"

// consensus.go — bench 083 rpc-reliability, cross-provider head
// agreement. The latency probe already fetches the full latest header
// (anti-cache design) and used to throw the hash away; here every
// successful probe feeds a per-chain height→hash quorum map so we can
// publish two things the latency bench cannot see:
//
//   rpc_consensus_lag_blocks  — how far this provider's head sits
//     behind the highest head any probed provider reported for the
//     same chain (the chainTips rolling max). Zero for a provider at
//     the shared tip; 1-2 for a gateway one block behind (observed
//     live on 1rpc/tenderly); tens for something wedged.
//
//   rpc_hash_mismatch_total  — the provider's hash at height H
//     disagrees with the hash a >=2-provider strict plurality agreed
//     on at H. Same-height hash divergence is the serious signal
//     (serving a non-canonical or fabricated block), so it is a
//     counter, incremented at most once per (provider, height).
//
// Reorg honesty: during a real reorg two providers can legitimately
// sit on different hashes at the same height. quorumHash requires a
// strict plurality (>=2 votes AND strictly more than any competing
// hash), so a 2-2 split counts nobody. Only a provider outvoted by an
// established majority is flagged.

const (
	// quorumMinProviders: minimum providers agreeing on one hash
	// before that hash is treated as canonical at its height.
	quorumMinProviders = 2
	// consensusPruneDepth: heights this far below the chain tip are
	// dropped from the vote map so memory stays bounded (~2 blocks/s
	// chains would otherwise grow forever).
	consensusPruneDepth uint64 = 128
)

type heightVotes struct {
	hash    map[string]string // provider -> reported hash
	flagged map[string]bool   // providers already counted at this height
}

type chainConsensus struct {
	heights map[uint64]*heightVotes
}

type consensusTracker struct {
	mu     sync.Mutex
	chains map[string]*chainConsensus
}

func newConsensusTracker() *consensusTracker {
	return &consensusTracker{chains: make(map[string]*chainConsensus)}
}

var consensus = newConsensusTracker()

// observe records one valid head probe. Called from probeOne for
// results classified ok or stale (a stale block is still a valid
// (height, hash) observation — its lag is exactly the point). hash is
// "" on the Solana path (getSlot carries no hash): lag is emitted,
// quorum voting is skipped.
func (t *consensusTracker) observe(chain, provider string, height uint64, hash string) {
	// Lag against the cross-provider rolling max the staleness check
	// already maintains. The caller updates tips before observing, so
	// a provider that IS the tip reads 0. Noise note: tips is updated
	// asynchronously by per-provider goroutines staggered across the
	// probe interval, so ±1 block of jitter on fast chains is expected
	// and averages out in the 24h quantiles.
	tip := tips.get(chain)
	lag := 0.0
	if tip > height {
		lag = float64(tip - height)
	}
	rpcConsensusLag.WithLabelValues(provider, chain, currentRegion).Set(lag)

	if hash == "" {
		return
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	cc := t.chains[chain]
	if cc == nil {
		cc = &chainConsensus{heights: make(map[uint64]*heightVotes)}
		t.chains[chain] = cc
	}
	hv := cc.heights[height]
	if hv == nil {
		hv = &heightVotes{hash: make(map[string]string), flagged: make(map[string]bool)}
		cc.heights[height] = hv
	}
	hv.hash[provider] = hash

	if q := quorumHash(hv.hash); q != "" {
		for p, h := range hv.hash {
			if h != q && !hv.flagged[p] {
				hv.flagged[p] = true
				rpcHashMismatch.WithLabelValues(p, chain, currentRegion).Inc()
			}
		}
	}

	for h := range cc.heights {
		if h+consensusPruneDepth < tip {
			delete(cc.heights, h)
		}
	}
}

// quorumHash returns the hash backed by >= quorumMinProviders votes
// AND strictly more votes than any competing hash. Ties (the 2-2 reorg
// split) return "" so no side is punished without a real majority.
func quorumHash(votes map[string]string) string {
	counts := make(map[string]int, len(votes))
	for _, h := range votes {
		counts[h]++
	}
	best, bestN, secondN := "", 0, 0
	for h, n := range counts {
		if n > bestN {
			best, secondN, bestN = h, bestN, n
		} else if n > secondN {
			secondN = n
		}
	}
	if bestN >= quorumMinProviders && bestN > secondN {
		return best
	}
	return ""
}

// initConsensusMetrics zero-initializes the mismatch counters for the
// full (provider × chain) matrix so `increase()` in the bench's
// incident queries resolves to 0 instead of an absent series for
// providers that never misbehave (which is, hopefully, most of them).
func initConsensusMetrics() {
	for _, c := range chains() {
		if c.Kind == "solana" {
			continue // no hash to vote on
		}
		for _, p := range c.Providers {
			rpcHashMismatch.WithLabelValues(p.Slug, c.Slug, currentRegion).Add(0)
		}
	}
}
