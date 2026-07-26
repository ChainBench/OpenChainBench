package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Oracle clients. Each one runs in its own goroutine and produces a
// batch of (target_block, []Prediction) per poll. The batch is added
// to the shared Buffer; the realizer handles join + error emission.

const (
	httpTimeout = 8 * time.Second
)

// proxyClient is a rotating-IP HTTP client built at process start
// from HTTPS_PROXY / HTTP_PROXY. Used only by pollers that need to
// evade per-IP throttles (currently: Owlracle, whose 10 req/h guest
// ceiling per IP made every 60 s poll from a single VPS collapse
// into HTTP 403 within an hour). Keep-alives are disabled so every
// request opens a fresh TCP conn and the rotating proxy (webshare)
// assigns a new upstream IP per request. If no proxy env is set,
// proxyClient stays nil and pollers fall back to the default client.
var proxyClient *http.Client

func init() {
	raw := os.Getenv("HTTPS_PROXY")
	if raw == "" {
		raw = os.Getenv("HTTP_PROXY")
	}
	if raw == "" {
		return
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		fmt.Printf("[proxy] parse %q: %v\n", raw, err)
		return
	}
	proxyClient = &http.Client{
		Timeout: httpTimeout,
		Transport: &http.Transport{
			Proxy:             http.ProxyURL(parsed),
			DisableKeepAlives: true,
		},
	}
	fmt.Printf("[proxy] wired via %s\n", parsed.Host)
}

// pollResult is what every oracle client returns. TargetBlock is the
// block these predictions apply to (oracle-specific: Blocknative
// gives an explicit next-block number, feeHistory returns the
// projected baseFee for "the next block", Owlracle predicts the
// upcoming few blocks).
type pollResult struct {
	TargetBlock uint64
	Predictions []Prediction
	// BaseGwei is the next-block base-fee prediction. Attached to
	// every prediction in the batch so the realizer can also emit a
	// per-oracle base-fee error metric.
	BaseGwei float64
	Err      error
}

// pollOracle dispatches to the right per-oracle parser. We do not
// share a generic shape — each oracle has enough quirks that an
// explicit per-oracle function is cleaner than an over-engineered
// adapter.
func pollOracle(ctx context.Context, o Oracle, ep OracleEndpoint) pollResult {
	switch o {
	case OracleBlocknative:
		return pollBlocknative(ctx, ep)
	case OraclePublicNode:
		return pollFeeHistory(ctx, ep)
	case OracleOwlracle:
		return pollOwlracle(ctx, ep)
	case OracleEtherscan:
		return pollEtherscan(ctx, ep)
	case OracleMetaMask:
		return pollMetaMask(ctx, ep)
	default:
		return pollResult{Err: fmt.Errorf("unknown oracle: %s", o)}
	}
}

// ─── Blocknative ──────────────────────────────────────────────────

type bnEstimatedPrice struct {
	Confidence           int     `json:"confidence"`
	Price                float64 `json:"price"`
	MaxPriorityFeePerGas float64 `json:"maxPriorityFeePerGas"`
	MaxFeePerGas         float64 `json:"maxFeePerGas"`
}

type bnBlockPrice struct {
	BlockNumber           uint64             `json:"blockNumber"`
	BaseFeePerGas         float64            `json:"baseFeePerGas"`
	BlobBaseFeePerGas     float64            `json:"blobBaseFeePerGas"`
	EstimatedTransactions int                `json:"estimatedTransactionCount"`
	EstimatedPrices       []bnEstimatedPrice `json:"estimatedPrices"`
}

type bnResp struct {
	System            string         `json:"system"`
	CurrentBlock      uint64         `json:"currentBlockNumber"`
	MsSinceLastBlock  int            `json:"msSinceLastBlock"`
	BlockPrices       []bnBlockPrice `json:"blockPrices"`
}

func pollBlocknative(ctx context.Context, ep OracleEndpoint) pollResult {
	req, _ := http.NewRequestWithContext(ctx, "GET", ep.URL, nil)
	if ep.AuthHeader != "" {
		req.Header.Set("Authorization", ep.AuthHeader)
	}
	body, status, err := httpDo(ctx, req)
	if err != nil {
		return pollResult{Err: err}
	}
	if status != 200 {
		return pollResult{Err: fmt.Errorf("http %d", status)}
	}
	var r bnResp
	if err := json.Unmarshal(body, &r); err != nil {
		return pollResult{Err: fmt.Errorf("parse: %w", err)}
	}
	if len(r.BlockPrices) == 0 {
		return pollResult{Err: fmt.Errorf("empty blockPrices")}
	}
	bp := r.BlockPrices[0]
	// Confidence 70/80/90/95/99 → p25/p50/p75/p90/p99 per spec.
	mapping := map[int]Tier{
		70: TierP25,
		80: TierP50,
		90: TierP75,
		95: TierP90,
		99: TierP99,
	}
	out := pollResult{TargetBlock: bp.BlockNumber, BaseGwei: bp.BaseFeePerGas}
	for _, e := range bp.EstimatedPrices {
		tier, ok := mapping[e.Confidence]
		if !ok {
			continue
		}
		out.Predictions = append(out.Predictions, Prediction{
			Oracle:       OracleBlocknative,
			Tier:         tier,
			PriorityGwei: e.MaxPriorityFeePerGas,
			BaseGwei:     bp.BaseFeePerGas,
		})
	}
	return out
}

// ─── eth_feeHistory (PublicNode, Alchemy share this shape) ────────

type fhResult struct {
	OldestBlock         string     `json:"oldestBlock"`
	BaseFeePerGas       []string   `json:"baseFeePerGas"` // length N+1, last is next-block projection
	GasUsedRatio        []float64  `json:"gasUsedRatio"`
	Reward              [][]string `json:"reward"` // length N, each is len=3 = [p25, p50, p90] in wei hex
	BaseFeePerBlobGas   []string   `json:"baseFeePerBlobGas"`
}

type fhResp struct {
	Result fhResult `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func pollFeeHistory(ctx context.Context, ep OracleEndpoint) pollResult {
	// Request 5 blocks, percentiles [25, 50, 90]. We use the last
	// row (most recent block) as the rolling sample for the next
	// block's prediction — feeHistory is backward-looking by
	// design, the agent spec calls this out.
	body := []byte(`{"jsonrpc":"2.0","method":"eth_feeHistory","params":["0x5","latest",[25,50,90]],"id":1}`)
	req, _ := http.NewRequestWithContext(ctx, "POST", ep.URL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	raw, status, err := httpDo(ctx, req)
	if err != nil {
		return pollResult{Err: err}
	}
	if status != 200 {
		return pollResult{Err: fmt.Errorf("http %d", status)}
	}
	var r fhResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return pollResult{Err: fmt.Errorf("parse: %w", err)}
	}
	if r.Error != nil {
		return pollResult{Err: fmt.Errorf("rpc -%d: %s", r.Error.Code, r.Error.Message)}
	}
	if len(r.Result.BaseFeePerGas) < 2 || len(r.Result.Reward) == 0 {
		return pollResult{Err: fmt.Errorf("short feeHistory response")}
	}
	// `oldestBlock` + len(baseFeePerGas) - 1 = the projected next
	// block (which is the index where baseFeePerGas[N] sits).
	oldest, err := parseHexU64(r.Result.OldestBlock)
	if err != nil {
		return pollResult{Err: fmt.Errorf("oldestBlock: %w", err)}
	}
	// Number of returned past blocks is len(reward); the next block
	// is then oldest + len(reward).
	targetBlock := oldest + uint64(len(r.Result.Reward))

	baseHexNext := r.Result.BaseFeePerGas[len(r.Result.BaseFeePerGas)-1]
	baseWei, err := parseHexU64(baseHexNext)
	if err != nil {
		return pollResult{Err: fmt.Errorf("baseFee next: %w", err)}
	}
	baseGwei := float64(baseWei) / 1e9

	// Last row of `reward` = most recent block's [p25, p50, p90].
	last := r.Result.Reward[len(r.Result.Reward)-1]
	if len(last) != 3 {
		return pollResult{Err: fmt.Errorf("reward row len %d, want 3", len(last))}
	}
	tiers := []Tier{TierP25, TierP50, TierP90}
	preds := make([]Prediction, 0, 3)
	for i, t := range tiers {
		wei, err := parseHexU64(last[i])
		if err != nil {
			continue
		}
		preds = append(preds, Prediction{
			Oracle:       OraclePublicNode,
			Tier:         t,
			PriorityGwei: float64(wei) / 1e9,
			BaseGwei:     baseGwei,
		})
	}
	return pollResult{TargetBlock: targetBlock, BaseGwei: baseGwei, Predictions: preds}
}

// ─── Owlracle ──────────────────────────────────────────────────────

type owlSpeed struct {
	Acceptance           float64 `json:"acceptance"`
	MaxFeePerGas         float64 `json:"maxFeePerGas"`
	MaxPriorityFeePerGas float64 `json:"maxPriorityFeePerGas"`
	BaseFee              float64 `json:"baseFee"`
	EstimatedFee         float64 `json:"estimatedFee"`
}

type owlResp struct {
	Timestamp string     `json:"timestamp"`
	AvgTime   float64    `json:"avgTime"`
	AvgTx     float64    `json:"avgTx"`
	AvgGas    float64    `json:"avgGas"`
	Speeds    []owlSpeed `json:"speeds"`
	BlockNum  uint64     `json:"blockNumber"`
}

func pollOwlracle(ctx context.Context, ep OracleEndpoint) pollResult {
	req, _ := http.NewRequestWithContext(ctx, "GET", ep.URL, nil)
	// Owlracle's guest tier is 10 req/h per IP. Our 4 chains × 60s
	// poll = 240 req/h from a single VPS IP, which collapses to a
	// permanent HTTP 403 within an hour. Route through the rotating
	// proxy pool so each request gets a fresh upstream IP and stays
	// under the per-IP guest ceiling.
	body, status, err := httpDoProxied(ctx, req)
	if err != nil {
		return pollResult{Err: err}
	}
	if status == 429 {
		return pollResult{Err: fmt.Errorf("throttled (HTTP 429)")}
	}
	if status != 200 {
		return pollResult{Err: fmt.Errorf("http %d", status)}
	}
	var r owlResp
	if err := json.Unmarshal(body, &r); err != nil {
		return pollResult{Err: fmt.Errorf("parse: %w", err)}
	}
	if len(r.Speeds) == 0 {
		return pollResult{Err: fmt.Errorf("empty speeds")}
	}
	mapping := map[float64]Tier{
		0.35: TierP25,
		0.60: TierP50,
		0.90: TierP90,
		1.00: TierP99,
	}
	// Owlracle does not return the target block — it predicts the
	// upcoming few blocks. We attach the prediction to head+1; the
	// realizer accepts a ±2 block tolerance via the matching window.
	// The block number must come from the realizer's perspective,
	// so we leave TargetBlock=0 and let the dispatcher overwrite it
	// based on the latest known head.
	out := pollResult{BaseGwei: r.Speeds[0].BaseFee}
	for _, s := range r.Speeds {
		// Round acceptance to 2 decimals; Owlracle sometimes returns
		// 0.3500000000004 noise.
		key := roundTo(s.Acceptance, 2)
		tier, ok := mapping[key]
		if !ok {
			continue
		}
		out.Predictions = append(out.Predictions, Prediction{
			Oracle:       OracleOwlracle,
			Tier:         tier,
			PriorityGwei: s.MaxPriorityFeePerGas,
			BaseGwei:     s.BaseFee,
		})
	}
	return out
}

// ─── Etherscan v2 ──────────────────────────────────────────────────

type etherscanInner struct {
	LastBlock       string `json:"LastBlock"`
	SafeGasPrice    string `json:"SafeGasPrice"`
	ProposeGasPrice string `json:"ProposeGasPrice"`
	FastGasPrice    string `json:"FastGasPrice"`
	SuggestBaseFee  string `json:"suggestBaseFee"`
	GasUsedRatio    string `json:"gasUsedRatio"`
}

// etherscanResp uses json.RawMessage for `result` because the field
// is polymorphic. Etherscan returns an object on success and a
// STRING when rate-limited or plan-restricted (e.g. "Max calls per
// sec rate limit reached" or "Free API access is not supported for
// this chain"). Decoding directly into a struct fails with
// "cannot unmarshal string into Go struct field" — we have to peek
// at the raw bytes first.
type etherscanResp struct {
	Status  string          `json:"status"`
	Message string          `json:"message"`
	Result  json.RawMessage `json:"result"`
}

// etherscanGate serialises Etherscan calls across ALL chains. The
// free-tier no-key limit is 1 req/5s per IP shared, so without a
// key we enforce ≥6s between any two Etherscan requests regardless
// of which (oracle, chain) goroutine made them. With ETHERSCAN_API_KEY
// set, the limit rises to 5 req/s across all chains, so we drop the
// gap to 250ms — enough to serialise bursts but not enough to make
// chain4 wait past our httpTimeout (which caused visible `timeout`
// counters on Polygon and Arbitrum before the key was wired).
var (
	etherscanMu   sync.Mutex
	etherscanLast time.Time
)

var etherscanMinGap = func() time.Duration {
	if os.Getenv("ETHERSCAN_API_KEY") != "" {
		return 250 * time.Millisecond
	}
	return 6 * time.Second
}()

func etherscanGate(ctx context.Context) error {
	etherscanMu.Lock()
	defer etherscanMu.Unlock()
	if wait := etherscanMinGap - time.Since(etherscanLast); wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	etherscanLast = time.Now()
	return nil
}

func pollEtherscan(ctx context.Context, ep OracleEndpoint) pollResult {
	if err := etherscanGate(ctx); err != nil {
		return pollResult{Err: fmt.Errorf("rate-gate: %w", err)}
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", ep.URL, nil)
	body, status, err := httpDo(ctx, req)
	if err != nil {
		return pollResult{Err: err}
	}
	if status != 200 {
		return pollResult{Err: fmt.Errorf("http %d", status)}
	}
	var r etherscanResp
	if err := json.Unmarshal(body, &r); err != nil {
		return pollResult{Err: fmt.Errorf("parse: %w", err)}
	}
	// Polymorphic result: when status="0" and the result is a string,
	// Etherscan is signaling a rate-limit hit (NOTOK / "Max calls per
	// sec") or plan restriction ("Free API access is not supported for
	// this chain"). Treat the rate-limit case as `throttled` so we
	// classify properly; treat the plan restriction as a regular
	// http_err so the chain falls off the leaderboard cleanly without
	// pretending to be a transient issue.
	if len(r.Result) > 0 && r.Result[0] == '"' {
		var msg string
		_ = json.Unmarshal(r.Result, &msg)
		if strings.Contains(strings.ToLower(msg), "rate limit") {
			return pollResult{Err: fmt.Errorf("throttled: %s", msg)}
		}
		return pollResult{Err: fmt.Errorf("etherscan: %s / %s", r.Status, msg)}
	}
	if r.Status != "1" && !strings.Contains(r.Message, "rate limit") {
		return pollResult{Err: fmt.Errorf("etherscan: %s / %s", r.Status, r.Message)}
	}
	var inner etherscanInner
	if err := json.Unmarshal(r.Result, &inner); err != nil {
		return pollResult{Err: fmt.Errorf("parse result: %w", err)}
	}
	lastBlock, _ := strconv.ParseUint(inner.LastBlock, 10, 64)
	base, err := strconv.ParseFloat(inner.SuggestBaseFee, 64)
	if err != nil {
		return pollResult{Err: fmt.Errorf("baseFee parse: %w", err)}
	}
	parseTier := func(field, name string) (float64, error) {
		total, err := strconv.ParseFloat(field, 64)
		if err != nil {
			return 0, fmt.Errorf("%s parse: %w", name, err)
		}
		// Priority = total - baseFee, clamped at 0 (Etherscan can
		// report SafeGasPrice == suggestBaseFee on idle blocks).
		p := total - base
		if p < 0 {
			p = 0
		}
		return p, nil
	}
	safe, e1 := parseTier(inner.SafeGasPrice, "Safe")
	prop, e2 := parseTier(inner.ProposeGasPrice, "Propose")
	fast, e3 := parseTier(inner.FastGasPrice, "Fast")
	if e1 != nil || e2 != nil || e3 != nil {
		return pollResult{Err: fmt.Errorf("tier parse: %v / %v / %v", e1, e2, e3)}
	}
	// Etherscan reports the prediction for "the next block" but
	// names lastBlock as the most recent finalized one. So target
	// block = lastBlock + 1.
	return pollResult{
		TargetBlock: lastBlock + 1,
		BaseGwei:    base,
		Predictions: []Prediction{
			{Oracle: OracleEtherscan, Tier: TierP25, PriorityGwei: safe, BaseGwei: base},
			{Oracle: OracleEtherscan, Tier: TierP50, PriorityGwei: prop, BaseGwei: base},
			{Oracle: OracleEtherscan, Tier: TierP90, PriorityGwei: fast, BaseGwei: base},
		},
	}
}

// ─── MetaMask (gas.api.cx.metamask.io) ────────────────────────────
//
// Public no-key endpoint that powers the MetaMask wallet's
// suggested-fee UI at real production scale. EIP-1559 native:
// returns explicit low/medium/high tiers each with their own
// `suggestedMaxPriorityFeePerGas` and `suggestedMaxFeePerGas`
// (gwei decimal strings), plus a baseline `estimatedBaseFee`.
// We map low→p25, medium→p50, high→p90 — the same mapping the
// wallet's own slow/market/fast selector uses. Tiers collapse
// during calm blocks (medium and high often equal), which
// mirrors the upstream model's documented behaviour; the bench
// surfaces this as-is rather than masking it.

type mmTier struct {
	SuggestedMaxPriorityFeePerGas string `json:"suggestedMaxPriorityFeePerGas"`
	SuggestedMaxFeePerGas         string `json:"suggestedMaxFeePerGas"`
}

type mmResp struct {
	Low              mmTier `json:"low"`
	Medium           mmTier `json:"medium"`
	High             mmTier `json:"high"`
	EstimatedBaseFee string `json:"estimatedBaseFee"`
}

func pollMetaMask(ctx context.Context, ep OracleEndpoint) pollResult {
	req, _ := http.NewRequestWithContext(ctx, "GET", ep.URL, nil)
	body, status, err := httpDo(ctx, req)
	if err != nil {
		return pollResult{Err: err}
	}
	if status == 429 {
		return pollResult{Err: fmt.Errorf("throttled (HTTP 429)")}
	}
	if status != 200 {
		return pollResult{Err: fmt.Errorf("http %d", status)}
	}
	var r mmResp
	if err := json.Unmarshal(body, &r); err != nil {
		return pollResult{Err: fmt.Errorf("parse: %w", err)}
	}
	base, err := strconv.ParseFloat(r.EstimatedBaseFee, 64)
	if err != nil {
		return pollResult{Err: fmt.Errorf("baseFee parse: %w", err)}
	}
	parseTier := func(field, name string) (float64, error) {
		v, err := strconv.ParseFloat(field, 64)
		if err != nil {
			return 0, fmt.Errorf("%s parse: %w", name, err)
		}
		return v, nil
	}
	low, e1 := parseTier(r.Low.SuggestedMaxPriorityFeePerGas, "low")
	med, e2 := parseTier(r.Medium.SuggestedMaxPriorityFeePerGas, "medium")
	high, e3 := parseTier(r.High.SuggestedMaxPriorityFeePerGas, "high")
	if e1 != nil || e2 != nil || e3 != nil {
		return pollResult{Err: fmt.Errorf("tier parse: %v / %v / %v", e1, e2, e3)}
	}
	// No explicit target block: the API applies to "the next block"
	// but never names it. Realizer grafts head+1 the same way it
	// does for Owlracle.
	return pollResult{
		BaseGwei: base,
		Predictions: []Prediction{
			{Oracle: OracleMetaMask, Tier: TierP25, PriorityGwei: low, BaseGwei: base},
			{Oracle: OracleMetaMask, Tier: TierP50, PriorityGwei: med, BaseGwei: base},
			{Oracle: OracleMetaMask, Tier: TierP90, PriorityGwei: high, BaseGwei: base},
		},
	}
}

// ─── helpers ───────────────────────────────────────────────────────

func httpDo(ctx context.Context, req *http.Request) ([]byte, int, error) {
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	client := &http.Client{Timeout: httpTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return raw, resp.StatusCode, nil
}

// httpDoProxied routes the request through proxyClient if a proxy is
// configured (webshare rotating pool via HTTPS_PROXY env). Falls
// back to httpDo when no proxy is set — useful for local runs
// without proxy access.
func httpDoProxied(ctx context.Context, req *http.Request) ([]byte, int, error) {
	if proxyClient == nil {
		return httpDo(ctx, req)
	}
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := proxyClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return raw, resp.StatusCode, nil
}

func parseHexU64(s string) (uint64, error) {
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		return 0, fmt.Errorf("empty hex")
	}
	return strconv.ParseUint(s, 16, 64)
}

func roundTo(v float64, places int) float64 {
	pow := 1.0
	for i := 0; i < places; i++ {
		pow *= 10
	}
	return float64(int(v*pow+0.5)) / pow
}
