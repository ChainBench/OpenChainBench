package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"time"
)

// Realized side: per-chain. Fetch the full block (with inline
// transactions) for each block we have pending predictions on, derive
// the realized priority-fee p25/p50/p90 + baseFee, then join against
// the per-chain Buffer and emit error metrics tagged with the chain
// label.

type rpcRawBlock struct {
	Result *struct {
		Number          string  `json:"number"`
		BaseFeePerGas   string  `json:"baseFeePerGas"`
		BlobGasUsed     string  `json:"blobGasUsed"`
		ExcessBlobGas   string  `json:"excessBlobGas"`
		Timestamp       string  `json:"timestamp"`
		Transactions    []rpcTx `json:"transactions"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type rpcTx struct {
	Type                 string `json:"type"`
	GasPrice             string `json:"gasPrice"`
	MaxFeePerGas         string `json:"maxFeePerGas"`
	MaxPriorityFeePerGas string `json:"maxPriorityFeePerGas"`
}

func fetchBlock(ctx context.Context, url string, blockNum uint64) (*rpcRawBlock, error) {
	tag := fmt.Sprintf("0x%x", blockNum)
	body := []byte(fmt.Sprintf(`{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["%s",true],"id":1}`, tag))
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	raw, status, err := httpDo(ctx, req)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("http %d", status)
	}
	var r rpcRawBlock
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc -%d: %s", r.Error.Code, r.Error.Message)
	}
	if r.Result == nil {
		return nil, fmt.Errorf("nil result")
	}
	return &r, nil
}

// fetchBlockBaseFee is a header-only variant of fetchBlock used by
// the quorum-verify path. It calls eth_getBlockByNumber with
// includeTxs=false so free-tier verify RPCs (Ankr / Cloudflare /
// dRPC public) don't rate-limit us for pulling the full tx list
// on every block when all we need to cross-check is the baseFee.
func fetchBlockBaseFee(ctx context.Context, url string, blockNum uint64) (uint64, error) {
	tag := fmt.Sprintf("0x%x", blockNum)
	body := []byte(fmt.Sprintf(`{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["%s",false],"id":1}`, tag))
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	raw, status, err := httpDo(ctx, req)
	if err != nil {
		return 0, err
	}
	if status != 200 {
		return 0, fmt.Errorf("http %d", status)
	}
	var r struct {
		Result *struct {
			BaseFeePerGas string `json:"baseFeePerGas"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	if r.Error != nil {
		return 0, fmt.Errorf("rpc -%d: %s", r.Error.Code, r.Error.Message)
	}
	if r.Result == nil {
		return 0, fmt.Errorf("nil result")
	}
	return parseHexU64(r.Result.BaseFeePerGas)
}

func headBlock(ctx context.Context, url string) (uint64, error) {
	body := []byte(`{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}`)
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	raw, status, err := httpDo(ctx, req)
	if err != nil {
		return 0, err
	}
	if status != 200 {
		return 0, fmt.Errorf("http %d", status)
	}
	var r struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, err
	}
	return parseHexU64(r.Result)
}

// realizedPercentiles is the full set of grade-against values a
// single block produces. Every tier an oracle can emit needs a real
// number to compare against; historically we approximated p75 as
// (p50+p90)/2 and p99 as p90 which was a factual bug — a vendor's
// engineer could grep it in 30 seconds and use it to invalidate
// every "p99 error" number on the leaderboard. Now every tier is
// computed from the actual tx effective-priority set.
type realizedPercentiles struct {
	P25, P50, P75, P90, P99 float64
	TxCount                 int
}

// derivePercentiles computes p25/p50/p75/p90/p99 of the validator-
// effective priority fee across all txs in the block. For EIP-1559
// txs the effective priority is `min(maxPriorityFeePerGas,
// maxFeePerGas - baseFeePerGas)` clamped at 0. For legacy txs
// (type 0x0) priority is implied: `max(0, gasPrice - baseFeePerGas)`.
// Both are included in the same sorted series because they competed
// for the same blockspace. Returns a zeroed struct for empty blocks;
// the caller treats that as a skip.
func derivePercentiles(baseGwei float64, txs []rpcTx) realizedPercentiles {
	if len(txs) == 0 {
		return realizedPercentiles{}
	}
	baseWei := uint64(baseGwei * 1e9)
	effective := make([]uint64, 0, len(txs))
	for _, t := range txs {
		switch t.Type {
		case "0x2", "0x3", "0x4":
			mpf, e1 := parseHexU64(t.MaxPriorityFeePerGas)
			mf, e2 := parseHexU64(t.MaxFeePerGas)
			if e1 != nil || e2 != nil {
				continue
			}
			cap := uint64(0)
			if mf > baseWei {
				cap = mf - baseWei
			}
			eff := mpf
			if cap < eff {
				eff = cap
			}
			effective = append(effective, eff)
		default: // 0x0 (legacy) or 0x1 (access list)
			gp, err := parseHexU64(t.GasPrice)
			if err != nil {
				continue
			}
			eff := uint64(0)
			if gp > baseWei {
				eff = gp - baseWei
			}
			effective = append(effective, eff)
		}
	}
	if len(effective) == 0 {
		return realizedPercentiles{}
	}
	sort.Slice(effective, func(i, j int) bool { return effective[i] < effective[j] })
	get := func(p float64) float64 {
		idx := int(math.Floor(p * float64(len(effective)-1)))
		return float64(effective[idx]) / 1e9
	}
	return realizedPercentiles{
		P25:     get(0.25),
		P50:     get(0.50),
		P75:     get(0.75),
		P90:     get(0.90),
		P99:     get(0.99),
		TxCount: len(effective),
	}
}

// runRealizer polls head every realizedPollInterval for ONE chain,
// fetches every block between lastObserved+1 and head (catch-up),
// joins against the chain's buffer, emits metrics tagged with the
// chain label. Started in its own goroutine, one per chain.
func runRealizer(ctx context.Context, buf *Buffer, chain Chain) {
	var lastObserved uint64
	t := time.NewTicker(realizedPollInterval)
	defer t.Stop()

	tick := func() {
		fetchCtx, cancel := context.WithTimeout(ctx, httpTimeout)
		defer cancel()
		head, err := headBlock(fetchCtx, chain.RealizedRPC)
		if err != nil {
			fmt.Printf("[realizer/%s] head fetch: %v\n", chain.Slug, err)
			return
		}
		// First run: prime lastObserved without backfilling.
		if lastObserved == 0 {
			lastObserved = head
			return
		}
		// Catch up at most 5 blocks per tick to bound the per-tick
		// work even if the realizer lagged behind. On Polygon /
		// Avalanche (2s block time, 12s realizer cadence) we expect
		// to see 6 new blocks per tick on average, so the catch-up
		// loop intentionally trails reality by a block or two —
		// that's fine because the buffer holds predictions for
		// pendingTTLBlocks worth of blocks anyway.
		for n := lastObserved + 1; n <= head && n <= lastObserved+5; n++ {
			processBlock(ctx, buf, n, chain)
			lastObserved = n
		}
		// Evict any pending entries older than the freshness floor
		// (some oracles target N-but-we-saw-N+pendingTTLBlocks).
		if head > pendingTTLBlocks {
			buf.EvictOlderThan(head - pendingTTLBlocks)
		}
		// Surface per-(oracle, chain) buffer sizes.
		for o, size := range buf.Sizes() {
			gasPendingBufferSize.WithLabelValues(string(o), chain.Slug).Set(float64(size))
		}
	}

	tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

func processBlock(ctx context.Context, buf *Buffer, blockNum uint64, chain Chain) {
	fetchCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	blk, err := fetchBlock(fetchCtx, chain.RealizedRPC, blockNum)
	if err != nil {
		fmt.Printf("[realizer/%s] block %d fetch: %v\n", chain.Slug, blockNum, err)
		return
	}
	baseWei, err := parseHexU64(blk.Result.BaseFeePerGas)
	if err != nil {
		// BSC / chains without EIP-1559 baseFee fall through with
		// baseWei=0; that's fine, priority fee is then the full
		// gasPrice on legacy txs. Currently no such chain is in the
		// matrix, but the fallback is cheap.
		baseWei = 0
	}
	baseGwei := float64(baseWei) / 1e9

	// Independent-upstream verification (red-team A1): if a second
	// RPC is configured for this chain, fetch the same block and
	// compare baseFee. Any mismatch increments a counter so the
	// leaderboard can surface how independent our ground truth
	// actually is. We do NOT stall on mismatch — the primary is
	// still trusted — because both endpoints being on public free
	// tiers means one being briefly stale is expected. Sustained
	// disagreement is a real signal.
	if chain.VerifyRPC != "" {
		vCtx, vCancel := context.WithTimeout(ctx, httpTimeout)
		vBaseWei, vErr := fetchBlockBaseFee(vCtx, chain.VerifyRPC, blockNum)
		vCancel()
		if vErr != nil {
			gasRealizedQuorumDisagree.WithLabelValues(chain.Slug, "verify_fetch_err").Inc()
			fmt.Printf("[realizer/%s] verify fetch err block=%d: %v\n", chain.Slug, blockNum, vErr)
		} else if vBaseWei != baseWei {
			gasRealizedQuorumDisagree.WithLabelValues(chain.Slug, "basefee_mismatch").Inc()
			fmt.Printf("[realizer/%s] quorum disagree block=%d primary_base=%.6f verify_base=%.6f\n",
				chain.Slug, blockNum, baseGwei, float64(vBaseWei)/1e9)
		}
	}

	pcts := derivePercentiles(baseGwei, blk.Result.Transactions)
	gasRealizedBase.WithLabelValues(chain.Slug).Set(baseGwei)
	gasRealizedTxCount.WithLabelValues(chain.Slug).Set(float64(pcts.TxCount))
	if pcts.TxCount > 0 {
		gasRealizedPriority.WithLabelValues(string(TierP25), chain.Slug).Set(pcts.P25)
		gasRealizedPriority.WithLabelValues(string(TierP50), chain.Slug).Set(pcts.P50)
		gasRealizedPriority.WithLabelValues(string(TierP75), chain.Slug).Set(pcts.P75)
		gasRealizedPriority.WithLabelValues(string(TierP90), chain.Slug).Set(pcts.P90)
		gasRealizedPriority.WithLabelValues(string(TierP99), chain.Slug).Set(pcts.P99)
	}

	// Every tier now grades against a real percentile of the mined
	// block. p75 and p99 used to be approximated as (p50+p90)/2 and
	// p90 respectively — replaced with real values so the leaderboard
	// doesn't measure predictions against synthetic references.
	realized := map[Tier]float64{
		TierP25: pcts.P25,
		TierP50: pcts.P50,
		TierP75: pcts.P75,
		TierP90: pcts.P90,
		TierP99: pcts.P99,
	}

	// Primary join: pull every pending prediction for THIS block
	// (exact match) plus the previous block (some oracles target a
	// slightly different head than the realizer's RPC sees, ±1
	// tolerance covers it).
	predictionsToCheck := buf.Take(blockNum)
	predictionsToCheck = append(predictionsToCheck, buf.Take(blockNum-1)...)

	now := time.Now()
	if len(predictionsToCheck) > 0 && pcts.TxCount > 0 {
		for _, p := range predictionsToCheck {
			ref, ok := realized[p.Tier]
			if !ok {
				continue
			}
			errPriority := math.Abs(p.PriorityGwei - ref)
			gasErrorPriorityGauge.WithLabelValues(string(p.Oracle), string(p.Tier), chain.Slug).Set(errPriority)
			gasErrorPriorityHist.WithLabelValues(string(p.Oracle), string(p.Tier), chain.Slug).Observe(errPriority)
			// Over/under split: only the side the oracle actually
			// erred on gets a sample this cycle. Percentile trackers
			// will build fat under histograms, inclusion-confidence
			// oracles will build fat over histograms; the leaderboard
			// can then rank on whichever side matches user intent.
			if p.PriorityGwei > ref {
				gasErrorPriorityOverHist.WithLabelValues(string(p.Oracle), string(p.Tier), chain.Slug).Observe(p.PriorityGwei - ref)
			} else if p.PriorityGwei < ref {
				gasErrorPriorityUnderHist.WithLabelValues(string(p.Oracle), string(p.Tier), chain.Slug).Observe(ref - p.PriorityGwei)
			}
			errBase := math.Abs(p.BaseGwei - baseGwei)
			gasErrorBaseGauge.WithLabelValues(string(p.Oracle), chain.Slug).Set(errBase)
			if !p.CapturedAt.IsZero() {
				gasPredictionAge.WithLabelValues(string(p.Oracle), chain.Slug).Observe(now.Sub(p.CapturedAt).Seconds())
			}
		}
	}

	// Lag2 join: at block N, grade predictions that targeted block
	// N-2 against the current block. Same tier reference values.
	// Emits into a separate histogram so the primary ranking is
	// unaffected while the leaderboard can add a "lag=2" secondary
	// column that removes the very-next-block latency-race bias.
	if blockNum >= 2 && pcts.TxCount > 0 {
		lag2Predictions := buf.TakeLag2(blockNum - 2)
		for _, p := range lag2Predictions {
			ref, ok := realized[p.Tier]
			if !ok {
				continue
			}
			gasErrorPriorityLag2Hist.WithLabelValues(string(p.Oracle), string(p.Tier), chain.Slug).Observe(math.Abs(p.PriorityGwei - ref))
		}
	}

	fmt.Printf("[realizer/%s] block=%d txs=%d base=%.3f p25/p50/p75/p90/p99=%.3f/%.3f/%.3f/%.3f/%.3f matched=%d\n",
		chain.Slug, blockNum, pcts.TxCount, baseGwei, pcts.P25, pcts.P50, pcts.P75, pcts.P90, pcts.P99, len(predictionsToCheck))
}
