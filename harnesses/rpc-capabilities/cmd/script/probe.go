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
	"sync"
	"time"
)

const (
	// 60s (was 30s): the cluster probes ~23 chains per provider from ONE
	// IP per region. Keyless per-IP budgets (1RPC daily cap, dRPC CU/s)
	// were saturated by our AGGREGATE load, publishing throttle-induced
	// error rates as "reliability" — measuring our own footprint, not the
	// provider. 60s halves per-IP pressure; sample size stays ample
	// (1440/day/region).
	probeInterval = 60 * time.Second
	probeTimeout  = 8 * time.Second
	// staleBlockGap: a returned block more than this far behind the
	// cross-provider tip is classified as `stale`. 20 blocks ≈ 4 min
	// on Ethereum which generously covers cross-provider drift.
	staleBlockGap uint64 = 20
)

// chainTips tracks the highest block seen for each chain across all
// providers. Staleness is judged relative to this rolling max, which
// avoids the trap of an honest endpoint being flagged stale when the
// reference itself lags.
type chainTips struct {
	mu  sync.RWMutex
	val map[string]uint64
}

func newChainTips() *chainTips {
	return &chainTips{val: make(map[string]uint64)}
}

func (t *chainTips) update(chain string, block uint64) {
	t.mu.Lock()
	if block > t.val[chain] {
		t.val[chain] = block
	}
	t.mu.Unlock()
}

func (t *chainTips) get(chain string) uint64 {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.val[chain]
}

var tips = newChainTips()

// rpcEnvelope keeps Result as a plain string; still used by archive.go
// (eth_blockNumber head lookup + eth_getBalance probes both return hex
// strings). The latency probe below parses an object result and has
// its own envelope.
type rpcEnvelope struct {
	Result string `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type rpcBlockEnvelope struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type blockHeader struct {
	Number string `json:"number"`
}

// callLatestBlock issues `eth_getBlockByNumber("latest", false)` and
// classifies the response into one of: ok, http_err, jsonrpc_err,
// timeout. Staleness is added by the caller because it requires the
// cross-provider tip context.
//
// Anti-cache probe design. The previous probe (`eth_blockNumber`) is
// served straight from some providers' edge caches without touching a
// node, which let cache-fronted gateways top the latency leaderboard
// on cache hits rather than real RPC work. Fetching the full latest
// header with a rotating request id defeats body-keyed edge caches;
// the header's `number` field keeps the staleness check intact.
func callLatestBlock(ctx context.Context, url string) (block uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":%d}`,
		time.Now().UnixNano(),
	))
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	client := &http.Client{Timeout: probeTimeout}

	start := time.Now()
	resp, err := client.Do(req)
	latencyMs = float64(time.Since(start).Milliseconds())

	if err != nil {
		if ctx.Err() != nil || strings.Contains(err.Error(), "deadline exceeded") || strings.Contains(err.Error(), "Timeout") {
			return 0, "timeout", latencyMs, err
		}
		return 0, "http_err", latencyMs, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return 0, "http_err", latencyMs, fmt.Errorf("status %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, "http_err", latencyMs, err
	}
	var r rpcBlockEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if r.Error != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("rpc -%d: %s", r.Error.Code, r.Error.Message)
	}
	if len(r.Result) == 0 || string(r.Result) == "null" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("empty result")
	}
	var hdr blockHeader
	if err := json.Unmarshal(r.Result, &hdr); err != nil {
		return 0, "jsonrpc_err", latencyMs, err
	}
	if hdr.Number == "" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("header missing number")
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(hdr.Number, "0x"), 16, 64)
	if err != nil {
		return 0, "jsonrpc_err", latencyMs, err
	}
	return n, "ok", latencyMs, nil
}

// StartProbeLoop spawns one goroutine per (chain × provider). Each
// goroutine runs forever, ticking every probeInterval.
func StartProbeLoop(ctx context.Context) {
	for _, c := range chains() {
		c := c
		for _, p := range c.Providers {
			p := p
			go probeOne(ctx, c, p)
		}
	}
}

func probeOne(ctx context.Context, c Chain, p Provider) {
	// Stagger startup deterministically across providers so the
	// first scrape doesn't fire 12 simultaneous outbound requests.
	jitter := time.Duration(int64(probeInterval) * urlJitter(p.URL+c.Slug) / 100)
	select {
	case <-ctx.Done():
		return
	case <-time.After(jitter):
	}

	t := time.NewTicker(probeInterval)
	defer t.Stop()

	tick := func() {
		probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
		defer cancel()
		block, result, latency, err := callLatestBlock(probeCtx, p.URL)

		if result == "ok" {
			tips.update(c.Slug, block)
			tip := tips.get(c.Slug)
			if tip > 0 && block+staleBlockGap < tip {
				result = "stale"
			}
		}
		rpcCallTotal.WithLabelValues(p.Slug, c.Slug, currentRegion, result).Inc()
		if result == "ok" {
			// Latency is recorded ONLY for fresh, valid responses. Error
			// responses are often FASTER than real work (Cloudflare's dead
			// eth endpoint 403s in ~20 ms and was topping the Ethereum
			// leaderboard for a week), and a gauge set on failure freezes
			// at that value forever. Deleting the series on failure lets
			// Prom staleness kick in so dead providers age out of the
			// p50 rankings instead of ranking on their last error's RTT.
			rpcLatency.WithLabelValues(p.Slug, c.Slug, currentRegion).Set(latency)
			rpcLatencyHist.WithLabelValues(p.Slug, c.Slug, currentRegion).Observe(latency)
			rpcHealth.WithLabelValues(p.Slug, c.Slug, currentRegion).Set(1)
			fmt.Printf("[%s/%s] block=%d latency=%.0fms\n", c.Slug, p.Slug, block, latency)
		} else {
			rpcLatency.DeleteLabelValues(p.Slug, c.Slug, currentRegion)
			rpcHealth.WithLabelValues(p.Slug, c.Slug, currentRegion).Set(0)
			fmt.Printf("[%s/%s] %s latency=%.0fms err=%v\n", c.Slug, p.Slug, result, latency, err)
		}
	}

	tick() // probe immediately so first /metrics scrape has data
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

// urlJitter returns a deterministic 0-99 from the URL+chain seed,
// used to spread probe startup across the probeInterval window.
func urlJitter(s string) int64 {
	var sum int64
	for _, c := range s {
		sum = (sum*131 + int64(c)) % 100
	}
	if sum < 0 {
		sum = -sum
	}
	return sum
}
