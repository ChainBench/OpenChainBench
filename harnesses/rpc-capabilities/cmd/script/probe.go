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
	// starknetStaleBlockGap: Starknet blocks are produced irregularly
	// (roughly every 2-6 minutes), so a gap of 5 blocks is generous
	// without masking real stale endpoints.
	starknetStaleBlockGap uint64 = 5
	// stellarStaleLedgerGap: Stellar closes a ledger every ~5 s, so
	// 60 ledgers ≈ 5 min gives the same tolerance as EVM at 12 s/block.
	stellarStaleLedgerGap uint64 = 60
	// suiStaleCheckpointGap: Sui checkpoints are produced every ~3 s,
	// so 100 checkpoints ≈ 5 min gives the same order of tolerance.
	suiStaleCheckpointGap uint64 = 100
	// aptosStaleBlockGap: Aptos produces roughly one block per second,
	// so 300 blocks ≈ 5 min.
	aptosStaleBlockGap uint64 = 300
	// xrplStaleLedgerGap: XRP Ledger closes every ~3-4 s, so 75 ledgers
	// ≈ 5 min.
	xrplStaleLedgerGap uint64 = 75
	// algorandStaleRoundGap: Algorand commits one round every ~3.5 s,
	// so 90 rounds ≈ 5 min.
	algorandStaleRoundGap uint64 = 90
	// gramStaleSeqnoGap: TON/Gram masterchain seqno advances every ~5 s,
	// so 60 seqnos ≈ 5 min.
	gramStaleSeqnoGap uint64 = 60
	// nearStaleBlockGap: NEAR commits ~1 block/s, so 300 blocks ≈ 5 min.
	nearStaleBlockGap uint64 = 300
	// flowStaleBlockGap: Flow Cadence commits one block every ~1.25 s,
	// so 240 blocks ≈ 5 min.
	flowStaleBlockGap uint64 = 240
	// hederaStaleBlockGap: Hedera EVM blocks every ~3 s, so 100 blocks ≈ 5 min.
	hederaStaleBlockGap uint64 = 100
	// ckbStaleBlockGap: Nervos CKB commits one block every ~10 s,
	// so 30 blocks ≈ 5 min.
	ckbStaleBlockGap uint64 = 30
	// multiversxStaleNonceGap: MultiversX meta-chain nonce advances every ~6 s,
	// so 50 nonces ≈ 5 min.
	multiversxStaleNonceGap uint64 = 50
	// neoStaleBlockGap: NEO N3 commits one block every ~15 s,
	// so 20 blocks ≈ 5 min.
	neoStaleBlockGap uint64 = 20
	// tezosStaleBlockGap: Tezos commits one block every ~30 s,
	// so 10 blocks ≈ 5 min.
	tezosStaleBlockGap uint64 = 10
	// antelopeStaleBlockGap: Antelope (EOS/WAX) produces one block every
	// ~0.5 s, so 600 blocks ≈ 5 min.
	antelopeStaleBlockGap uint64 = 600
	// wavesStaleBlockGap: Waves closes a block every ~60 s,
	// so 5 blocks ≈ 5 min.
	wavesStaleBlockGap uint64 = 5
	// dogecoinStaleBlockGap: Dogecoin produces one block every ~60 s,
	// so 5 blocks ≈ 5 min gives the same reliability tolerance as EVM.
	dogecoinStaleBlockGap uint64 = 5
	// zcashStaleBlockGap: Zcash produces one block every ~75 s,
	// so 4 blocks ≈ 5 min.
	zcashStaleBlockGap uint64 = 4
	// veChainStaleBlockGap: VeChain produces one block every ~10 s,
	// so 30 blocks ≈ 5 min.
	veChainStaleBlockGap uint64 = 30
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
		case "starknet":
			block, result, latency, err = callStarknetBlockNumber(probeCtx, p.URL)
		case "stellar":
			block, result, latency, err = callStellarLatestLedger(probeCtx, p.URL)
		case "sui":
			block, result, latency, err = callSuiCheckpoint(probeCtx, p.URL)
		case "aptos":
			block, result, latency, err = callAptosLedger(probeCtx, p.URL)
		case "xrpl":
			block, result, latency, err = callXrplLedger(probeCtx, p.URL)
		case "algorand":
			block, result, latency, err = callAlgorandStatus(probeCtx, p.URL)
		case "gram":
			block, result, latency, err = callGramSeqno(probeCtx, p.URL)
		case "near":
			block, result, latency, err = callNearBlock(probeCtx, p.URL)
		case "flow":
			block, result, latency, err = callFlowBlock(probeCtx, p.URL)
		case "ckb":
			block, result, latency, err = callCkbTipBlockNumber(probeCtx, p.URL)
		case "multiversx":
			block, result, latency, err = callMultiversxNonce(probeCtx, p.URL)
		case "neo":
			block, result, latency, err = callNeoBlockCount(probeCtx, p.URL)
		case "zcash":
			if strings.Contains(p.URL, "blockchair.com") {
				block, result, latency, err = callBlockchairZec(probeCtx, p.URL)
			} else {
				block, result, latency, err = callNeoBlockCount(probeCtx, p.URL)
			}
		case "dogecoin":
			if strings.Contains(p.URL, "blockcypher.com") {
				block, result, latency, err = callBlockCypherDoge(probeCtx, p.URL)
			} else {
				block, result, latency, err = callNeoBlockCount(probeCtx, p.URL)
			}
		case "tezos":
			block, result, latency, err = callTezosBlock(probeCtx, p.URL)
		case "antelope":
			block, result, latency, err = callAntelopeChainInfo(probeCtx, p.URL)
		case "waves":
			block, result, latency, err = callWavesBlock(probeCtx, p.URL)
		case "vechain":
			block, result, latency, err = callVeChainBlock(probeCtx, p.URL)
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
			case "starknet":
				gap = starknetStaleBlockGap
			case "stellar":
				gap = stellarStaleLedgerGap
			case "sui":
				gap = suiStaleCheckpointGap
			case "aptos":
				gap = aptosStaleBlockGap
			case "xrpl":
				gap = xrplStaleLedgerGap
			case "algorand":
				gap = algorandStaleRoundGap
			case "gram":
				gap = gramStaleSeqnoGap
			case "near":
				gap = nearStaleBlockGap
			case "flow":
				gap = flowStaleBlockGap
			case "hedera":
				gap = hederaStaleBlockGap
			case "ckb":
				gap = ckbStaleBlockGap
			case "multiversx":
				gap = multiversxStaleNonceGap
			case "neo":
				gap = neoStaleBlockGap
			case "zcash":
				gap = zcashStaleBlockGap
			case "dogecoin":
				gap = dogecoinStaleBlockGap
			case "tezos":
				gap = tezosStaleBlockGap
			case "antelope":
				gap = antelopeStaleBlockGap
			case "waves":
				gap = wavesStaleBlockGap
			case "vechain":
				gap = veChainStaleBlockGap
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
		case "solana", "polkadot", "cosmos", "starknet", "stellar",
			"sui", "aptos", "xrpl", "algorand", "gram",
			"near", "flow", "hedera", "ckb", "multiversx", "neo",
			"tezos", "antelope", "waves", "vechain", "dogecoin", "zcash":
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

// callStarknetBlockNumber is the Starknet probe path: starknet_blockNumber
// with a rotating request id. Returns the current block number as uint64.
// Staleness uses starknetStaleBlockGap in probeOne.
func callStarknetBlockNumber(ctx context.Context, url string) (block uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"starknet_blockNumber","params":[],"id":%d}`,
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
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("non-numeric block number: %s", string(r.Result)[:min(len(r.Result), 40)])
	}
	return n, "ok", latencyMs, nil
}

// stellarLedger is the shape of the getLatestLedger result on Stellar Soroban RPC.
type stellarLedger struct {
	Sequence uint64 `json:"sequence"`
}

// suiCheckpointResult is the shape of sui_getLatestCheckpointSequenceNumber result.
// The RPC returns the sequence number as a decimal string.
type suiCheckpointResult struct {
	Result string `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// aptosLedgerInfo is the shape of GET /v1/ on an Aptos REST node.
type aptosLedgerInfo struct {
	BlockHeight string `json:"block_height"`
}

// xrplLedgerCurrentResp is the HTTP JSON-RPC response for ledger_current.
// XRPL does not use jsonrpc:2.0 — error signal is result.status="error".
type xrplLedgerCurrentResp struct {
	Result struct {
		LedgerCurrentIndex uint64 `json:"ledger_current_index"`
		Status             string `json:"status"`
		ErrorMessage       string `json:"error_message"`
	} `json:"result"`
}

// algorandStatus is the shape of GET /v2/status on an Algorand algod node.
type algorandStatus struct {
	LastRound uint64 `json:"last-round"`
}

// gramApiResp handles both toncenter's {ok,result,...} envelope and plain
// JSON-RPC 2.0 {result,...} responses from other TON providers.
type gramApiResp struct {
	OK     *bool           `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type gramMasterchainInfo struct {
	Last struct {
		Seqno uint64 `json:"seqno"`
	} `json:"last"`
}

// callStellarLatestLedger is the Stellar Soroban RPC probe path: getLatestLedger
// with a rotating request id. Returns the ledger sequence as block number.
// Staleness uses stellarStaleLedgerGap in probeOne.
func callStellarLatestLedger(ctx context.Context, url string) (ledger uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"getLatestLedger","params":{},"id":%d}`,
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
	var sl stellarLedger
	if err := json.Unmarshal(r.Result, &sl); err != nil {
		return 0, "jsonrpc_err", latencyMs, err
	}
	if sl.Sequence == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("stellar ledger missing sequence")
	}
	return sl.Sequence, "ok", latencyMs, nil
}

// callSuiCheckpoint probes a Sui full-node using sui_getLatestCheckpointSequenceNumber.
// The result is a decimal string; staleness uses suiStaleCheckpointGap in probeOne.
func callSuiCheckpoint(ctx context.Context, url string) (seq uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"sui_getLatestCheckpointSequenceNumber","params":[],"id":%d}`,
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
	var r suiCheckpointResult
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if r.Error != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("rpc -%d: %s", r.Error.Code, r.Error.Message)
	}
	seqStr := strings.Trim(r.Result, `"`)
	if seqStr == "" || seqStr == "null" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("empty checkpoint result")
	}
	n, err := strconv.ParseUint(seqStr, 10, 64)
	if err != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("non-numeric checkpoint: %s", seqStr[:min(len(seqStr), 40)])
	}
	return n, "ok", latencyMs, nil
}

// callAptosLedger probes an Aptos full-node via the REST ledger info endpoint (GET /v1/).
// block_height is a decimal string in the response body.
// Staleness uses aptosStaleBlockGap in probeOne.
func callAptosLedger(ctx context.Context, url string) (height uint64, result string, latencyMs float64, err error) {
	target := strings.TrimRight(url, "/")
	if !strings.HasSuffix(target, "/v1") {
		target = target + "/v1"
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	req.Header.Set("Accept", "application/json")
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
	var info aptosLedgerInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if info.BlockHeight == "" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("aptos ledger missing block_height")
	}
	n, err := strconv.ParseUint(info.BlockHeight, 10, 64)
	if err != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("non-numeric block_height: %s", info.BlockHeight[:min(len(info.BlockHeight), 40)])
	}
	return n, "ok", latencyMs, nil
}

// callXrplLedger probes an XRP Ledger node using the ledger_current JSON-RPC method.
// XRPL uses its own JSON-RPC envelope (no jsonrpc:2.0 field; error lives in result.status).
// Staleness uses xrplStaleLedgerGap in probeOne.
func callXrplLedger(ctx context.Context, url string) (idx uint64, result string, latencyMs float64, err error) {
	body := []byte(`{"method":"ledger_current","params":[{}]}`)
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
	var r xrplLedgerCurrentResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if r.Result.Status == "error" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("xrpl error: %s", r.Result.ErrorMessage)
	}
	if r.Result.LedgerCurrentIndex == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("xrpl missing ledger_current_index")
	}
	return r.Result.LedgerCurrentIndex, "ok", latencyMs, nil
}

// callAlgorandStatus probes an Algorand algod node via REST GET /v2/status.
// last-round is the latest committed round (analogous to block height).
// Staleness uses algorandStaleRoundGap in probeOne.
func callAlgorandStatus(ctx context.Context, url string) (round uint64, result string, latencyMs float64, err error) {
	target := strings.TrimRight(url, "/") + "/v2/status"
	req, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	req.Header.Set("Accept", "application/json")
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
	var s algorandStatus
	if err := json.Unmarshal(raw, &s); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if s.LastRound == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("algorand status missing last-round")
	}
	return s.LastRound, "ok", latencyMs, nil
}

// callGramSeqno probes a TON/Gram node via getMasterchainInfo JSON-RPC.
// Handles both toncenter's {ok,result,...} envelope and plain JSON-RPC 2.0.
// Staleness uses gramStaleSeqnoGap in probeOne.
func callGramSeqno(ctx context.Context, url string) (seqno uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"getMasterchainInfo","params":{},"id":%d}`,
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
	var gr gramApiResp
	if err := json.Unmarshal(raw, &gr); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if gr.Error != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("rpc -%d: %s", gr.Error.Code, gr.Error.Message)
	}
	if gr.OK != nil && !*gr.OK {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("toncenter ok=false")
	}
	if len(gr.Result) == 0 || string(gr.Result) == "null" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("empty gram result")
	}
	var mc gramMasterchainInfo
	if err := json.Unmarshal(gr.Result, &mc); err != nil {
		return 0, "jsonrpc_err", latencyMs, err
	}
	if mc.Last.Seqno == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("gram masterchain missing seqno")
	}
	return mc.Last.Seqno, "ok", latencyMs, nil
}

// nearBlockHeader is the shape of result.header in a NEAR `block` JSON-RPC response.
type nearBlockHeader struct {
	Height uint64 `json:"height"`
}

type nearBlockResult struct {
	Header nearBlockHeader `json:"header"`
}

// callNearBlock probes a NEAR node via the `block` JSON-RPC method with finality=final.
// Staleness uses nearStaleBlockGap in probeOne.
func callNearBlock(ctx context.Context, url string) (height uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"block","params":{"finality":"final"},"id":%d}`,
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
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("empty near result")
	}
	var blk nearBlockResult
	if err := json.Unmarshal(r.Result, &blk); err != nil {
		return 0, "jsonrpc_err", latencyMs, err
	}
	if blk.Header.Height == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("near block missing height")
	}
	return blk.Header.Height, "ok", latencyMs, nil
}

// flowBlockEntry is the shape of one element in the array returned by
// GET /v1/blocks?height=sealed on the Flow Cadence REST API.
type flowBlockEntry struct {
	Header struct {
		Height string `json:"height"`
	} `json:"header"`
}

// callFlowBlock probes a Flow node via the Cadence REST endpoint GET /v1/blocks?height=sealed.
// The height field is a decimal string. Staleness uses flowStaleBlockGap in probeOne.
func callFlowBlock(ctx context.Context, url string) (height uint64, result string, latencyMs float64, err error) {
	target := strings.TrimRight(url, "/") + "/v1/blocks?height=sealed"
	req, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	req.Header.Set("Accept", "application/json")
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
	var blocks []flowBlockEntry
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if len(blocks) == 0 || blocks[0].Header.Height == "" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("flow blocks response empty or missing height")
	}
	n, err := strconv.ParseUint(blocks[0].Header.Height, 10, 64)
	if err != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("non-numeric flow height: %s", blocks[0].Header.Height[:min(len(blocks[0].Header.Height), 40)])
	}
	return n, "ok", latencyMs, nil
}

// callCkbTipBlockNumber probes a Nervos CKB node via get_tip_block_number JSON-RPC.
// The result is a hex string ("0x..."). Staleness uses ckbStaleBlockGap in probeOne.
func callCkbTipBlockNumber(ctx context.Context, url string) (height uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"get_tip_block_number","params":[],"id":%d}`,
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
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("empty ckb result")
	}
	var hexStr string
	if err := json.Unmarshal(r.Result, &hexStr); err != nil {
		return 0, "jsonrpc_err", latencyMs, err
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(hexStr, "0x"), 16, 64)
	if err != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("non-hex ckb block number: %s", hexStr[:min(len(hexStr), 40)])
	}
	return n, "ok", latencyMs, nil
}

// multiversxNetworkStatus is the shape of GET /network/status/4294967295 on MultiversX gateway.
type multiversxNetworkStatus struct {
	Data struct {
		Status struct {
			ErdNonce uint64 `json:"erd_nonce"`
		} `json:"status"`
	} `json:"data"`
	Code string `json:"code"`
}

// callMultiversxNonce probes a MultiversX node via GET /network/status/4294967295 (metachain).
// erd_nonce is the metachain block nonce (analogous to block height).
// Staleness uses multiversxStaleNonceGap in probeOne.
func callMultiversxNonce(ctx context.Context, url string) (nonce uint64, result string, latencyMs float64, err error) {
	target := strings.TrimRight(url, "/") + "/network/status/4294967295"
	req, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	req.Header.Set("Accept", "application/json")
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
	var st multiversxNetworkStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if st.Code != "successful" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("multiversx status code: %s", st.Code)
	}
	if st.Data.Status.ErdNonce == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("multiversx missing erd_nonce")
	}
	return st.Data.Status.ErdNonce, "ok", latencyMs, nil
}

// tezosBlockHeader is the shape returned by GET /chains/main/blocks/head/header
// on a Tezos node. `level` is a plain integer (not a string).
type tezosBlockHeader struct {
	Level uint64 `json:"level"`
}

// callTezosBlock probes a Tezos node via the REST endpoint
// GET /chains/main/blocks/head/header. The `level` field is the current
// block level. Staleness uses tezosStaleBlockGap in probeOne.
func callTezosBlock(ctx context.Context, url string) (level uint64, result string, latencyMs float64, err error) {
	target := strings.TrimRight(url, "/") + "/chains/main/blocks/head/header"
	req, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	req.Header.Set("Accept", "application/json")
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
	var hdr tezosBlockHeader
	if err := json.Unmarshal(raw, &hdr); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if hdr.Level == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("tezos block header missing level")
	}
	return hdr.Level, "ok", latencyMs, nil
}

// antelopeChainInfo is the shape returned by GET /v1/chain/get_info
// on an Antelope (EOS, WAX) node. `head_block_num` is a plain integer.
type antelopeChainInfo struct {
	HeadBlockNum uint64 `json:"head_block_num"`
}

// callAntelopeChainInfo probes an Antelope (EOS/WAX) node via
// GET /v1/chain/get_info. Returns head_block_num as the block height.
// Staleness uses antelopeStaleBlockGap in probeOne.
func callAntelopeChainInfo(ctx context.Context, url string) (blockNum uint64, result string, latencyMs float64, err error) {
	target := strings.TrimRight(url, "/") + "/v1/chain/get_info"
	req, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	req.Header.Set("Accept", "application/json")
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
	var info antelopeChainInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if info.HeadBlockNum == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("antelope chain info missing head_block_num")
	}
	return info.HeadBlockNum, "ok", latencyMs, nil
}

// wavesBlock is the shape returned by GET /blocks/last on a Waves node.
// `height` is a plain integer.
type wavesBlock struct {
	Height uint64 `json:"height"`
}

// callWavesBlock probes a Waves node via GET /blocks/last.
// Returns the block height. Staleness uses wavesStaleBlockGap in probeOne.
func callWavesBlock(ctx context.Context, url string) (height uint64, result string, latencyMs float64, err error) {
	target := strings.TrimRight(url, "/") + "/blocks/last"
	req, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	req.Header.Set("Accept", "application/json")
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
	var blk wavesBlock
	if err := json.Unmarshal(raw, &blk); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if blk.Height == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("waves block missing height")
	}
	return blk.Height, "ok", latencyMs, nil
}

// veChainBlock is the shape returned by GET /blocks/best on a VeChain node.
// `number` is a plain integer (not hex).
type veChainBlock struct {
	Number uint64 `json:"number"`
}

// callVeChainBlock probes a VeChain node via GET /blocks/best.
// Returns the block number. Staleness uses veChainStaleBlockGap in probeOne.
func callVeChainBlock(ctx context.Context, url string) (blockNum uint64, result string, latencyMs float64, err error) {
	target := strings.TrimRight(url, "/") + "/blocks/best"
	req, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	req.Header.Set("Accept", "application/json")
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
	var blk veChainBlock
	if err := json.Unmarshal(raw, &blk); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if blk.Number == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("vechain block missing number")
	}
	return blk.Number, "ok", latencyMs, nil
}

// callNeoBlockCount probes a NEO N3 node via getblockcount JSON-RPC.
// The result is a plain decimal integer. Staleness uses neoStaleBlockGap in probeOne.
func callNeoBlockCount(ctx context.Context, url string) (count uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"getblockcount","params":[],"id":%d}`,
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
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("empty neo result")
	}
	var n uint64
	if err := json.Unmarshal(r.Result, &n); err != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("non-numeric neo block count: %s", string(r.Result)[:min(len(r.Result), 40)])
	}
	return n, "ok", latencyMs, nil
}

// callBlockchairZec probes the Blockchair REST API for Zcash mainnet.
// GET https://api.blockchair.com/zcash/stats — reads data.best_block_height.
func callBlockchairZec(ctx context.Context, url string) (height uint64, result string, latencyMs float64, err error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
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

	var body struct {
		Data struct {
			BestBlockHeight uint64 `json:"best_block_height"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if body.Data.BestBlockHeight == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("blockchair zec: best_block_height=0")
	}
	return body.Data.BestBlockHeight, "ok", latencyMs, nil
}

// callBlockCypherDoge probes the BlockCypher REST API for Dogecoin mainnet.
// GET https://api.blockcypher.com/v1/doge/main — reads the `height` field.
func callBlockCypherDoge(ctx context.Context, url string) (height uint64, result string, latencyMs float64, err error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
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

	var body struct {
		Height uint64 `json:"height"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if body.Height == 0 {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("blockcypher doge: height=0")
	}
	return body.Height, "ok", latencyMs, nil
}
