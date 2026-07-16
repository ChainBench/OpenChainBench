package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	archiveProbeInterval = 1 * time.Hour
	archiveProbeTimeout  = 15 * time.Second
	// archiveTestAddr: Vitalik. Stable, well-known, non-zero balance
	// at any depth — so the response is unambiguous and a
	// non-pruned node always returns a valid hex value. A pruned
	// node returns either an explicit `missing trie node` error or
	// an unhelpful `0x0` even though the address has eth at that
	// height; both we count as failures.
	archiveTestAddr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
	// archivePerCallSpacing: meowrpc rate-limits aggressively on
	// rapid sequential calls (HTTP 429 within seconds). A 2 s spacer
	// between depth probes per provider keeps every endpoint happy
	// without lengthening total scrape time meaningfully (5 depths ×
	// 2 s = 10 s per provider, run once an hour).
	archivePerCallSpacing = 2 * time.Second
)

// depthBuckets is the set of (head - N) depths we probe. Geth's
// default state cap is 128 blocks, so the 300 bucket is the canonical
// pruned-vs-archive separator; the rest cover progressively deeper
// history up to block 5_000_000 which roughly maps to 2018.
var depthBuckets = []uint64{300, 7200, 216000, 1296000, 5000000}

// StartArchiveLoop spawns one goroutine per (chain × provider). Each
// goroutine probes all depths once, then ticks every
// archiveProbeInterval. Initial delay so the latency loop populates
// /metrics first.
func StartArchiveLoop(ctx context.Context) {
	for _, c := range chains() {
		c := c
		if c.Kind == "solana" || c.Kind == "polkadot" {
			// eth_getBalance at historical heights has no Solana or
			// Substrate equivalent on public endpoints (Polkadot state
			// is accessed via state_getStorage keyed by a Blake2
			// hashed storage key, no chain-agnostic depth analog);
			// skip the archive loop.
			continue
		}
		for _, p := range c.Providers {
			p := p
			go archiveOne(ctx, c, p)
		}
	}
}

func archiveOne(ctx context.Context, c Chain, p Provider) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(45 * time.Second):
	}

	tick := func() {
		head, err := getHeadBlock(ctx, p.URL)
		if err != nil {
			fmt.Printf("[archive/%s/%s] cannot fetch head: %v\n", c.Slug, p.Slug, err)
			// Mark every depth as unsupported so a flap doesn't
			// leave a stale `1` in the time series.
			for _, d := range depthBuckets {
				rpcArchiveDepth.WithLabelValues(p.Slug, c.Slug, currentRegion, fmt.Sprintf("%d", d)).Set(0)
			}
			return
		}
		for _, d := range depthBuckets {
			if head <= d {
				// Chain doesn't have enough history (Base, BNB
				// younger than 5M blocks). Skip silently — we
				// don't want to penalize an L2 for being young.
				continue
			}
			target := head - d
			ok := probeBalance(ctx, p.URL, target)
			val := 0.0
			if ok {
				val = 1.0
			}
			rpcArchiveDepth.WithLabelValues(p.Slug, c.Slug, currentRegion, fmt.Sprintf("%d", d)).Set(val)
			fmt.Printf("[archive/%s/%s] depth=%d head=%d ok=%v\n", c.Slug, p.Slug, d, head, ok)
			select {
			case <-ctx.Done():
				return
			case <-time.After(archivePerCallSpacing):
			}
		}
	}

	tick()
	t := time.NewTicker(archiveProbeInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

// getHeadBlock issues a single eth_blockNumber against url. We do not
// reuse the latency loop's value because the provider's own perceived
// head is the right reference for archive probing (avoids the case
// where another provider is ahead).
func getHeadBlock(ctx context.Context, url string) (uint64, error) {
	body := []byte(`{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}`)
	c, cancel := context.WithTimeout(ctx, archiveProbeTimeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	client := &http.Client{Timeout: archiveProbeTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("http %d", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)
	var r rpcEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, err
	}
	if r.Error != nil || r.Result == "" {
		return 0, fmt.Errorf("rpc err")
	}
	return strconv.ParseUint(strings.TrimPrefix(r.Result, "0x"), 16, 64)
}

// probeBalance returns true iff the provider serves a valid balance
// at the given historical block. Pruned responses come back as
// `error: "missing trie node"`; we treat any error or empty/zero
// `0x0` result as a miss because for Vitalik's address the real
// answer is always non-zero at any depth past 2015.
func probeBalance(ctx context.Context, url string, block uint64) bool {
	tag := fmt.Sprintf("0x%x", block)
	body := fmt.Sprintf(`{"jsonrpc":"2.0","method":"eth_getBalance","params":["%s","%s"],"id":1}`, archiveTestAddr, tag)
	c, cancel := context.WithTimeout(ctx, archiveProbeTimeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, "POST", url, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	client := &http.Client{Timeout: archiveProbeTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false
	}
	raw, _ := io.ReadAll(resp.Body)
	var r rpcEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return false
	}
	if r.Error != nil {
		return false
	}
	if r.Result == "" || r.Result == "0x" || r.Result == "0x0" {
		return false
	}
	return strings.HasPrefix(r.Result, "0x")
}
