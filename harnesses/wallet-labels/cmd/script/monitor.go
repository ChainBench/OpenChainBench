package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Wallet sample queued for label lookup.
type sample struct {
	address      string
	chain        string
	kind         string // "contract" | "eoa" — carried into Prom labels so the bench can split by anchor kind
	discoveredAt time.Time
}

// queue holds samples waiting for the post-discovery delay before being
// queried. Bounded — drop on full so a slow provider can't OOM the proc.
type queue struct {
	mu    sync.Mutex
	items []sample
	max   int
}

func newQueue(max int) *queue { return &queue{max: max} }

func (q *queue) push(s sample) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) >= q.max {
		return false // full, drop
	}
	q.items = append(q.items, s)
	queueDepth.Set(float64(len(q.items)))
	return true
}

func (q *queue) popReady(now time.Time, delay time.Duration) (sample, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, s := range q.items {
		if now.Sub(s.discoveredAt) >= delay {
			q.items = append(q.items[:i], q.items[i+1:]...)
			queueDepth.Set(float64(len(q.items)))
			return s, true
		}
	}
	return sample{}, false
}

// runWorkers spawns N goroutines that pull from the queue and run all
// providers in parallel for each address. We don't fan out lookups across
// chains — providers' Supports() filters each call to relevant chains.
func runWorkers(ctx context.Context, cfg *Config, q *queue, providers []Provider) {
	for i := 0; i < cfg.Workers; i++ {
		go func() {
			tick := time.NewTicker(200 * time.Millisecond)
			defer tick.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
				}
				s, ok := q.popReady(time.Now(), cfg.CheckDelay)
				if !ok {
					continue
				}
				lookupAll(ctx, providers, s)
			}
		}()
	}
}

// lookupAll runs every supported provider in parallel for the given sample.
func lookupAll(ctx context.Context, providers []Provider, s sample) {
	var wg sync.WaitGroup
	results := make(chan LabelResult, len(providers))
	for _, p := range providers {
		if !p.Supports(s.chain) {
			continue
		}
		wg.Add(1)
		go func(p Provider) {
			defer wg.Done()
			ctx2, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			r := p.Lookup(ctx2, s.chain, s.address)
			results <- r
		}(p)
	}
	wg.Wait()
	close(results)

	any := false
	compact := ""
	for r := range results {
		// Skipped calls (currently only Moralis self-throttle) don't go
		// to recordCheck — they neither succeeded nor failed, so leaving
		// them out keeps the success/checks ratio honest.
		if r.Skipped {
			recordSkipped(r.Provider, r.Chain)
			compact += " " + abbrev(r.Provider) + ":-"
			continue
		}
		recordCheck(r.Provider, r.Chain, s.kind, r.HasLabel, float64(r.LatencyMs), r.Err)
		recordDebug(debugEntry{
			Provider: r.Provider, Chain: r.Chain, Address: r.Address,
			HasLabel: r.HasLabel, LatencyMs: r.LatencyMs,
			Err: errStr(r.Err), Label: r.Label, Raw: r.Raw,
		})
		mark := "✗"
		if r.HasLabel {
			mark = "✓"
			any = true
		}
		compact += " " + abbrev(r.Provider) + ":" + mark
	}
	if any {
		fmt.Printf("[WL] %s/%s |%s\n", trim(s.address, 14), s.chain, compact)
	}
}

// abbrev returns a 3-letter unambiguous prefix for known providers.
func abbrev(p string) string {
	switch p {
	case "mobula":
		return "Mob"
	case "moralis":
		return "Mor"
	case "blockscout":
		return "Bs"
	case "oli":
		return "OLI"
	case "helius":
		return "Hel"
	case "tonapi":
		return "Ton"
	case "stellarexpert":
		return "Stx"
	case "xrpscan":
		return "Xrp"
	case "walletexplorer":
		return "Wex"
	}
	if len(p) > 3 {
		return p[:3]
	}
	return p
}

func errStr(e error) string {
	if e == nil {
		return ""
	}
	return e.Error()
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
