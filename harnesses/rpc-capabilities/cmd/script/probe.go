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
	// solanaStaleSlotGap: slots tick every ~400ms, so 300 slots is
	// ~2 minutes behind the cross-provider tip - the same order of
	// tolerance the EVM gap gives a 12s-block chain.
	solanaStaleSlotGap uint64 = 300
	// polkadotStaleBlockGap: Polkadot relay produces one block every
	// ~6 s, so 40 blocks ≈ 4 min. Same order of tolerance the EVM
	// gap gives a 12s-block chain, scaled for the faster relay
	// cadence.
	polkadotStaleBlockGap uint64 = 40
	// cosmosStaleBlockGap: Osmosis (CometBFT) commits one block every
	// ~6 s (same order as Polkadot's relay), so 40 blocks ≈ 4 min
	// gives the same reliability tolerance the EVM cluster gets on
	// 12 s-block chains. Kept as its own constant so a future Cosmos
	// chain with a faster block time (e.g. Injective ~0.65 s) can
	// override without touching the Polkadot reader.
	cosmosStaleBlockGap uint64 = 40
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
	Hash   string `json:"hash"`
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
// the header's `number` field keeps the staleness check intact and its
// `hash` feeds the bench-083 cross-provider quorum map (consensus.go).
func callLatestBlock(ctx context.Context, url string) (block uint64, hash string, result string, latencyMs float64, err error) {
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
	latencyMs = float64(time.Since(start).Nanoseconds()) / 1e6

	if err != nil {
		if ctx.Err() != nil || strings.Contains(err.Error(), "deadline exceeded") || strings.Contains(err.Error(), "Timeout") {
			return 0, "", "timeout", latencyMs, err
		}
		return 0, "", "http_err", latencyMs, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return 0, "", "http_err", latencyMs, fmt.Errorf("status %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, "", "http_err", latencyMs, err
	}
	var r rpcBlockEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, "", "http_err", latencyMs, err
	}
	if r.Error != nil {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("rpc -%d: %s", r.Error.Code, r.Error.Message)
	}
	if len(r.Result) == 0 || string(r.Result) == "null" {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("empty result")
	}
	var hdr blockHeader
	if err := json.Unmarshal(r.Result, &hdr); err != nil {
		return 0, "", "jsonrpc_err", latencyMs, err
	}
	if hdr.Number == "" {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("header missing number")
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(hdr.Number, "0x"), 16, 64)
	if err != nil {
		return 0, "", "jsonrpc_err", latencyMs, err
	}
	return n, hdr.Hash, "ok", latencyMs, nil
}

// StartProbeLoop spawns one goroutine per (chain × provider). Each
// goroutine runs forever, ticking every probeInterval.
func StartProbeLoop(ctx context.Context) {
	initConsensusMetrics()
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
		var block uint64
		var hash string
		var result string
		var latency float64
		var err error
		switch c.Kind {
		case "solana":
			block, result, latency, err = callLatestSlot(probeCtx, p.URL)
		case "polkadot":
			block, hash, result, latency, err = callSubstrateHeader(probeCtx, p.URL)
		case "cosmos":
			block, hash, result, latency, err = callCosmosStatus(probeCtx, p.URL)
		default:
			block, hash, result, latency, err = callLatestBlock(probeCtx, p.URL)
		}

		if result == "ok" {
			tips.update(c.Slug, block)
			tip := tips.get(c.Slug)
			gap := staleBlockGap
			switch c.Kind {
			case "solana":
				gap = solanaStaleSlotGap
			case "polkadot":
				gap = polkadotStaleBlockGap
			case "cosmos":
				gap = cosmosStaleBlockGap
			}
			if tip > 0 && block+gap < tip {
				result = "stale"
			}
		}
		// Bench 083: valid observations (fresh or stale, both carry a
		// real height + hash) feed the consensus lag gauge and the
		// height→hash quorum map; anything else deletes the lag series
		// so a dead endpoint ages out instead of freezing. Skipped on
		// chains whose probe cannot return the current-block hash
		// (Solana: getSlot returns a number only; Polkadot: header
		// carries parentHash, not the current block hash; Cosmos:
		// Tendermint `status` returns `latest_block_hash` on the same
		// block the height is reported for, so quorum is technically
		// feasible but the v1 Osmosis add-on ships without it to keep
		// the reliability change surface small — revisit once the
		// hash normalisation across Cosmos chains is validated).
		switch c.Kind {
		case "solana", "polkadot", "cosmos":
			// no consensus participation
		default:
			if result == "ok" || result == "stale" {
				consensus.observe(c.Slug, p.Slug, block, hash)
			} else {
				rpcConsensusLag.DeleteLabelValues(p.Slug, c.Slug, currentRegion)
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

// callLatestSlot is the Solana probe path: getSlot at the processed
// commitment with a rotating request id (same anti-cache rule as the
// EVM header fetch). The result is a plain JSON number (the slot), so
// the staleness comparison reuses the chainTips machinery with slots
// in place of block numbers.
func callLatestSlot(ctx context.Context, url string) (slot uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"getSlot","params":[{"commitment":"processed"}],"id":%d}`,
		time.Now().UnixNano(),
	))
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	client := &http.Client{Timeout: probeTimeout}

	start := time.Now()
	resp, err := client.Do(req)
	latencyMs = float64(time.Since(start).Nanoseconds()) / 1e6

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
	n, err := strconv.ParseUint(strings.TrimSpace(string(r.Result)), 10, 64)
	if err != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("non-numeric slot: %s", string(r.Result)[:min(len(r.Result), 40)])
	}
	return n, "ok", latencyMs, nil
}

// substrateHeader is the shape of the `chain_getHeader` result on
// Polkadot / Kusama and every Substrate-based relay chain. The block
// number is hex-encoded (`0x` prefix) matching the EVM header convention,
// so the parse path reuses the same strconv rule. `parentHash` is here
// so the consensus.go quorum map can key on it identically to EVM
// (bench 083 cross-provider height-hash agreement).
type substrateHeader struct {
	Number     string `json:"number"`
	ParentHash string `json:"parentHash"`
}

// callSubstrateHeader is the Polkadot probe path: chain_getHeader with a
// rotating request id (same anti-cache rule as the EVM header fetch).
// Returns the block number and parent hash so the caller can plug the
// probe result into the same tips / consensus machinery the EVM chain
// path uses. The returned "block" is the relay-chain block height, not
// a chain-agnostic slot: staleness classification uses
// polkadotStaleBlockGap in probeOne.
func callSubstrateHeader(ctx context.Context, url string) (block uint64, hash string, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"chain_getHeader","params":[],"id":%d}`,
		time.Now().UnixNano(),
	))
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	client := &http.Client{Timeout: probeTimeout}

	start := time.Now()
	resp, err := client.Do(req)
	latencyMs = float64(time.Since(start).Nanoseconds()) / 1e6

	if err != nil {
		if ctx.Err() != nil || strings.Contains(err.Error(), "deadline exceeded") || strings.Contains(err.Error(), "Timeout") {
			return 0, "", "timeout", latencyMs, err
		}
		return 0, "", "http_err", latencyMs, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return 0, "", "http_err", latencyMs, fmt.Errorf("status %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, "", "http_err", latencyMs, err
	}
	var r rpcBlockEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, "", "http_err", latencyMs, err
	}
	if r.Error != nil {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("rpc -%d: %s", r.Error.Code, r.Error.Message)
	}
	if len(r.Result) == 0 || string(r.Result) == "null" {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("empty result")
	}
	var hdr substrateHeader
	if err := json.Unmarshal(r.Result, &hdr); err != nil {
		return 0, "", "jsonrpc_err", latencyMs, err
	}
	if hdr.Number == "" {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("substrate header missing number")
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(hdr.Number, "0x"), 16, 64)
	if err != nil {
		return 0, "", "jsonrpc_err", latencyMs, err
	}
	return n, hdr.ParentHash, "ok", latencyMs, nil
}

// tendermintStatus is the shape returned by CometBFT / Tendermint
// `status` on every Cosmos SDK chain. Only `sync_info` is parsed here;
// `node_info` + `validator_info` are ignored because they carry
// operator-scoped metadata that doesn't feed the reliability signal.
// `latest_block_height` is a decimal string (unlike EVM / Substrate
// which hex-encode). `latest_block_hash` is hex (no `0x` prefix) so it
// slots into the same consensus.observe path if ever wired.
type tendermintStatus struct {
	SyncInfo struct {
		LatestBlockHeight string `json:"latest_block_height"`
		LatestBlockHash   string `json:"latest_block_hash"`
	} `json:"sync_info"`
}

// callCosmosStatus is the Cosmos SDK probe path: Tendermint `status`
// via JSON-RPC POST with a rotating request id (same anti-cache rule as
// the EVM header fetch). Returns the current block height + hash so the
// caller plugs the probe result into the shared tips machinery.
// Consensus participation is opted out in probeOne for v1.
func callCosmosStatus(ctx context.Context, url string) (block uint64, hash string, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"status","params":[],"id":%d}`,
		time.Now().UnixNano(),
	))
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	client := &http.Client{Timeout: probeTimeout}

	start := time.Now()
	resp, err := client.Do(req)
	latencyMs = float64(time.Since(start).Nanoseconds()) / 1e6

	if err != nil {
		if ctx.Err() != nil || strings.Contains(err.Error(), "deadline exceeded") || strings.Contains(err.Error(), "Timeout") {
			return 0, "", "timeout", latencyMs, err
		}
		return 0, "", "http_err", latencyMs, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return 0, "", "http_err", latencyMs, fmt.Errorf("status %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, "", "http_err", latencyMs, err
	}
	var r rpcBlockEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, "", "http_err", latencyMs, err
	}
	if r.Error != nil {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("rpc -%d: %s", r.Error.Code, r.Error.Message)
	}
	if len(r.Result) == 0 || string(r.Result) == "null" {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("empty result")
	}
	var st tendermintStatus
	if err := json.Unmarshal(r.Result, &st); err != nil {
		return 0, "", "jsonrpc_err", latencyMs, err
	}
	if st.SyncInfo.LatestBlockHeight == "" {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("tendermint status missing latest_block_height")
	}
	n, err := strconv.ParseUint(st.SyncInfo.LatestBlockHeight, 10, 64)
	if err != nil {
		return 0, "", "jsonrpc_err", latencyMs, fmt.Errorf("non-numeric latest_block_height: %q", st.SyncInfo.LatestBlockHeight)
	}
	return n, st.SyncInfo.LatestBlockHash, "ok", latencyMs, nil
}
