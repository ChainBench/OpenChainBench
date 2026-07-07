package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultProbeSeconds = 60
	probeTimeout        = 8 * time.Second
	// Quota guard trips at 90% of the region's monthly budget: the
	// point is to NEVER exhaust a free API key (a dead key blanks the
	// bench until someone rotates it — same failure mode as the
	// CoinStats credits incident).
	quotaGuardRatio = 0.90

	staleBlockGapEVM    uint64 = 20  // ~4 min on Ethereum
	staleSlotGapSolana  uint64 = 300 // ~2 min of slots
)

func probeInterval() time.Duration {
	if v := strings.TrimSpace(os.Getenv("RPC_KEYED_PROBE_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 15 {
			return time.Duration(n) * time.Second
		}
	}
	return defaultProbeSeconds * time.Second
}

// ---------------------------------------------------------------------------
// Quota guard: in-memory per-provider monthly request counter. Resets on
// calendar-month rollover AND on process restart — restarts under-count,
// which is safe (budgets already target ≤2/3 of the real quota, and the
// guard is belt-and-suspenders on top of that headroom).
// ---------------------------------------------------------------------------

type quotaGuard struct {
	mu     sync.Mutex
	month  string
	counts map[string]int64
}

var quota = &quotaGuard{counts: make(map[string]int64)}

// allow reserves one request for provider. Returns false when the
// region budget guard has tripped for the current month.
func (q *quotaGuard) allow(provider, region string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	m := time.Now().UTC().Format("2006-01")
	if m != q.month {
		q.month = m
		q.counts = make(map[string]int64)
	}
	budget := budgetFor(provider)
	used := q.counts[provider]
	ratio := float64(used) / float64(budget)
	quotaUsedRatio.WithLabelValues(provider, region).Set(ratio)
	if ratio >= quotaGuardRatio {
		return false
	}
	q.counts[provider] = used + 1
	return true
}

// ---------------------------------------------------------------------------
// Cross-provider chain tips for staleness classification (same design
// as the no-key harness: rolling max so an honest endpoint is not
// flagged stale when the reference itself lags).
// ---------------------------------------------------------------------------

type chainTips struct {
	mu  sync.RWMutex
	val map[string]uint64
}

var tips = &chainTips{val: make(map[string]uint64)}

func (t *chainTips) update(chain string, v uint64) {
	t.mu.Lock()
	if v > t.val[chain] {
		t.val[chain] = v
	}
	t.mu.Unlock()
}

func (t *chainTips) get(chain string) uint64 {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.val[chain]
}

// ---------------------------------------------------------------------------
// Probes. EVM mirrors the no-key harness anti-cache probe exactly
// (eth_getBlockByNumber("latest", false) + rotating id) so keyed and
// no-key numbers stay methodologically comparable. Solana probes
// getSlot at processed commitment — the lightest call that still
// travels to a validator-backed node.
// ---------------------------------------------------------------------------

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

func doPost(ctx context.Context, url string, body []byte) (raw []byte, latencyMs float64, classified string, err error) {
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	client := &http.Client{Timeout: probeTimeout}

	start := time.Now()
	resp, err := client.Do(req)
	latencyMs = float64(time.Since(start).Milliseconds())
	if err != nil {
		if ctx.Err() != nil || strings.Contains(err.Error(), "deadline exceeded") || strings.Contains(err.Error(), "Timeout") {
			return nil, latencyMs, "timeout", err
		}
		return nil, latencyMs, "http_err", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, latencyMs, "http_err", fmt.Errorf("status %d", resp.StatusCode)
	}
	raw, err = io.ReadAll(resp.Body)
	if err != nil {
		return nil, latencyMs, "http_err", err
	}
	return raw, latencyMs, "", nil
}

func probeEVM(ctx context.Context, url string) (head uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":%d}`,
		time.Now().UnixNano(),
	))
	raw, latencyMs, classified, err := doPost(ctx, url, body)
	if classified != "" {
		return 0, classified, latencyMs, err
	}
	var r rpcBlockEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if r.Error != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("rpc %d: %s", r.Error.Code, r.Error.Message)
	}
	if len(r.Result) == 0 || string(r.Result) == "null" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("empty result")
	}
	var hdr blockHeader
	if err := json.Unmarshal(r.Result, &hdr); err != nil || hdr.Number == "" {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("header missing number")
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(hdr.Number, "0x"), 16, 64)
	if err != nil {
		return 0, "jsonrpc_err", latencyMs, err
	}
	return n, "ok", latencyMs, nil
}

func probeSolana(ctx context.Context, url string) (slot uint64, result string, latencyMs float64, err error) {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"getSlot","params":[{"commitment":"processed"}],"id":%d}`,
		time.Now().UnixNano(),
	))
	raw, latencyMs, classified, err := doPost(ctx, url, body)
	if classified != "" {
		return 0, classified, latencyMs, err
	}
	var r rpcBlockEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, "http_err", latencyMs, err
	}
	if r.Error != nil {
		return 0, "jsonrpc_err", latencyMs, fmt.Errorf("rpc %d: %s", r.Error.Code, r.Error.Message)
	}
	n, err := strconv.ParseUint(strings.Trim(string(r.Result), `"`), 10, 64)
	if err != nil {
		return 0, "jsonrpc_err", latencyMs, err
	}
	return n, "ok", latencyMs, nil
}

// ---------------------------------------------------------------------------
// Probe loop
// ---------------------------------------------------------------------------

func StartProbeLoop(ctx context.Context) {
	for _, e := range endpoints() {
		e := e
		go probeOne(ctx, e)
	}
}

func probeOne(ctx context.Context, e Endpoint) {
	interval := probeInterval()
	jitter := time.Duration(int64(interval) * urlJitter(e.URL+e.Chain) / 100)
	select {
	case <-ctx.Done():
		return
	case <-time.After(jitter):
	}

	t := time.NewTicker(interval)
	defer t.Stop()

	tick := func() {
		if !quota.allow(e.Provider, currentRegion) {
			rpcCallTotal.WithLabelValues(e.Provider, e.Chain, currentRegion, "quota_paused", "keyed").Inc()
			rpcHealth.WithLabelValues(e.Provider, e.Chain, currentRegion, "keyed").Set(0)
			rpcLatency.DeleteLabelValues(e.Provider, e.Chain, currentRegion, "keyed")
			fmt.Printf("[%s/%s] quota guard tripped (>=90%% of monthly region budget) — paused until month rollover\n", e.Chain, e.Provider)
			return
		}

		probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
		defer cancel()

		var head uint64
		var result string
		var latency float64
		var err error
		if e.Kind == "solana" {
			head, result, latency, err = probeSolana(probeCtx, e.URL)
		} else {
			head, result, latency, err = probeEVM(probeCtx, e.URL)
		}

		if result == "ok" {
			tips.update(e.Chain, head)
			tip := tips.get(e.Chain)
			gap := staleBlockGapEVM
			if e.Kind == "solana" {
				gap = staleSlotGapSolana
			}
			if tip > 0 && head+gap < tip {
				result = "stale"
			}
		}
		rpcCallTotal.WithLabelValues(e.Provider, e.Chain, currentRegion, result, "keyed").Inc()
		if result == "ok" {
			// Same rule as the no-key harness: latency is recorded ONLY
			// for fresh valid responses (error responses are often faster
			// than real work and would poison the p50).
			rpcLatency.WithLabelValues(e.Provider, e.Chain, currentRegion, "keyed").Set(latency)
			rpcLatencyHist.WithLabelValues(e.Provider, e.Chain, currentRegion, "keyed").Observe(latency)
			rpcHealth.WithLabelValues(e.Provider, e.Chain, currentRegion, "keyed").Set(1)
			fmt.Printf("[%s/%s] head=%d latency=%.0fms\n", e.Chain, e.Provider, head, latency)
		} else {
			rpcLatency.DeleteLabelValues(e.Provider, e.Chain, currentRegion, "keyed")
			rpcHealth.WithLabelValues(e.Provider, e.Chain, currentRegion, "keyed").Set(0)
			// Go http errors embed the full request URL, which carries the
			// API key in the path/query for every provider here. Redact it
			// before logging so keys never land in service logs.
			msg := ""
			if err != nil {
				msg = strings.ReplaceAll(err.Error(), e.URL, "<"+e.Provider+"-endpoint>")
			}
			fmt.Printf("[%s/%s] %s latency=%.0fms err=%s\n", e.Chain, e.Provider, result, latency, msg)
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
