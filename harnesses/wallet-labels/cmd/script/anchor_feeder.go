package main

import (
	"context"
	"math/rand"
	"time"
)

// runAnchorFeeder cycles through the curated anchor list and pushes each
// address onto the queue at a steady rate. We loop forever — every full
// pass takes `loopMinutes` minutes, which keeps each provider sampled at
// roughly the same cadence.
//
// The order is shuffled per loop so providers can't just pre-cache "the
// first N addresses we'll be asked about".
func runAnchorFeeder(ctx context.Context, q *queue) {
	if len(anchorSample) == 0 {
		appendLog("[anchors] empty list — feeder will not run")
		return
	}
	loopMinutes := 30 // full pass over all anchors every 30 min
	gap := time.Duration(loopMinutes*60/len(anchorSample)) * time.Second
	if gap < 5*time.Second {
		gap = 5 * time.Second
	}
	appendLog("[anchors] feeder starting: %d addresses, %v between checks (%dmin loop)",
		len(anchorSample), gap, loopMinutes)

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	for {
		order := rng.Perm(len(anchorSample))
		for _, idx := range order {
			a := anchorSample[idx]
			if !q.push(sample{
				address:      a.Address,
				chain:        a.Chain,
				discoveredAt: time.Now(),
			}) {
				// queue full — wait a bit so workers can catch up.
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(gap):
			}
		}
	}
}
