package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// indexer-latency — bench №084.
//
// How fast does indexing infrastructure make new onchain events
// queryable? One probe event per interval: pick a fresh USDC Transfer
// from the newest Ethereum block via our keyless reference RPC
// (T0 = the instant WE first see the block), then poll each indexing
// pipeline on a front-loaded schedule until block N's data is
// queryable (lag = poll time − T0) or 240s passes (timeout).
//
// $0 methodology: no canary contract, we piggyback on the natural
// high-frequency USDC stream. Ground truth is a random organic
// transfer, different every event, publicly re-verifiable by tx hash.

func main() {
	installLogCapture() // capture stdout into /logs ring buffer

	fmt.Println("=== Indexer Latency Harness (bench 084) ===")
	fmt.Println("OpenChainBench — onchain event → indexer time-to-queryable.")
	fmt.Printf("Reference RPC: %s\n", rpcHTTP())

	// Keyless reachability proof: HyperSync /height vs our RPC head.
	if h, err := hypersyncHeight(); err == nil {
		fmt.Printf("HyperSync /height (keyless): %d\n", h)
	} else {
		fmt.Printf("HyperSync /height (keyless): unreachable (%s)\n", sanitize(err))
	}

	enabled := 0
	fmt.Printf("Chain: %s | event interval: %s | poll cap: %ds\n", chainSlug, eventInterval(), pollSchedule[len(pollSchedule)-1])
	for _, p := range cohort {
		state := "disabled (credential missing)"
		if p.Enabled() {
			state = fmt.Sprintf("enabled everyN=%d budget=%d calls/mo", p.EveryN, p.Budget)
			enabled++
		}
		fmt.Printf("  - %-10s %s\n", p.Slug, state)
	}
	if enabled == 0 {
		fmt.Println("[warn] no provider credentials set (HYPERSYNC_TOKEN / GRAPH_API_KEY / MOBULA_API_KEY)")
		fmt.Println("[warn] running in degraded mode: events sampled, all providers report result=disabled")
	}

	addr := ":2112"
	if v := strings.TrimSpace(os.Getenv("METRICS_ADDR")); v != "" {
		addr = v
	}
	fmt.Printf("Metrics server: %s/metrics\n\n", addr)
	go func() {
		if err := StartMetricsServer(addr); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runEvents(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] %v\n", s)
	cancel()
}

func runEvents(ctx context.Context) {
	t := time.NewTicker(eventInterval())
	defer t.Stop()
	var lastSeen uint64
	eventN := 0
	for {
		eventN++
		ev, t0 := waitFreshEvent(ctx, lastSeen)
		if ev.Block == 0 {
			return // ctx cancelled
		}
		lastSeen = ev.Block
		fmt.Printf("[event %d] block=%d usdc-transfer tx=%s\n", eventN, ev.Block, ev.TxHash[:14]+"…")

		var wg sync.WaitGroup
		for _, p := range cohort {
			if eventN%p.EveryN != 0 {
				continue
			}
			if !p.Enabled() {
				probeTotal.WithLabelValues(p.Slug, "disabled").Inc()
				health.WithLabelValues(p.Slug).Set(0)
				fmt.Printf("  %-10s disabled (credential missing)\n", p.Slug)
				continue
			}
			if !quota.allow(p) {
				probeTotal.WithLabelValues(p.Slug, "quota_paused").Inc()
				fmt.Printf("  %-10s quota guard tripped — paused until month rollover\n", p.Slug)
				continue
			}
			wg.Add(1)
			go func(p Provider) {
				defer wg.Done()
				raceProvider(ctx, p, ev, t0)
			}(p)
		}
		wg.Wait()

		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// raceProvider polls one indexing pipeline on the shared front-loaded
// schedule until block bn's probe event is queryable, or the schedule
// is exhausted (timeout), or every poll errored (error).
func raceProvider(ctx context.Context, p Provider, ev probeEvent, t0 time.Time) {
	var lastErr error
	polls, errs := 0, 0
	for _, after := range pollSchedule {
		wait := time.Until(t0.Add(time.Duration(after) * time.Second))
		if wait > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
		polls++
		found, err := p.Check(ev)
		if err != nil {
			errs++
			lastErr = err
			continue
		}
		if found {
			lag := time.Since(t0).Seconds()
			latencyHist.WithLabelValues(p.Slug).Observe(lag)
			latencyLast.WithLabelValues(p.Slug).Set(lag)
			probeTotal.WithLabelValues(p.Slug, "found").Inc()
			health.WithLabelValues(p.Slug).Set(1)
			fmt.Printf("  %-10s queryable in %.1fs\n", p.Slug, lag)
			return
		}
	}
	health.WithLabelValues(p.Slug).Set(0)
	// "error" only when EVERY poll of the event errored (matches the spec's
	// classification). An event with at least one clean "not yet" answer is a
	// timeout: reclassifying it as error would drop it from the success-rate
	// denominator and let transient blips inflate a provider's score.
	if errs == polls && lastErr != nil {
		probeTotal.WithLabelValues(p.Slug, "error").Inc()
		fmt.Printf("  %-10s error: %s\n", p.Slug, sanitize(lastErr))
		return
	}
	probeTotal.WithLabelValues(p.Slug, "timeout").Inc()
	if lastErr != nil {
		fmt.Printf("  %-10s TIMEOUT (not queryable within %ds; %d/%d polls errored, last: %s)\n", p.Slug, pollSchedule[len(pollSchedule)-1], errs, polls, sanitize(lastErr))
		return
	}
	fmt.Printf("  %-10s TIMEOUT (not queryable within %ds)\n", p.Slug, pollSchedule[len(pollSchedule)-1])
}

// ---------------------------------------------------------------------------
// Reference sampler: T0 from OUR keyless RPC (publicnode), never a
// cohort member's endpoint. 500ms head polling bounds the T0 error at
// +500ms, identical for every provider.
// ---------------------------------------------------------------------------

var httpClient = &http.Client{Timeout: 8 * time.Second}

func rpcCall(method, params string) (json.RawMessage, error) {
	body := fmt.Sprintf(`{"jsonrpc":"2.0","method":"%s","params":%s,"id":%d}`, method, params, time.Now().UnixNano())
	req, err := http.NewRequest("POST", rpcHTTP(), strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	if env.Error != nil {
		return nil, fmt.Errorf("rpc: %s", env.Error.Message)
	}
	return env.Result, nil
}

func headBlock() (uint64, error) {
	res, err := rpcCall("eth_blockNumber", "[]")
	if err != nil {
		return 0, err
	}
	var hexN string
	if err := json.Unmarshal(res, &hexN); err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimPrefix(hexN, "0x"), 16, 64)
}

type rpcLog struct {
	TransactionHash string   `json:"transactionHash"`
	Topics          []string `json:"topics"`
}

// recipient extracts the ERC-20 Transfer `to` address from topics[2]
// (32-byte left-padded). Empty string when the log shape is unexpected.
func recipient(l rpcLog) string {
	if len(l.Topics) < 3 || len(l.Topics[2]) != 66 {
		return ""
	}
	return "0x" + l.Topics[2][26:]
}

// usdcTransfersInBlock returns the tx hashes of USDC Transfer logs in
// block bn, via eth_getLogs on the reference RPC.
func usdcTransfersInBlock(bn uint64) ([]rpcLog, error) {
	params := fmt.Sprintf(`[{"fromBlock":"0x%x","toBlock":"0x%x","address":"%s","topics":["%s"]}]`, bn, bn, usdcContract, transferTopic)
	res, err := rpcCall("eth_getLogs", params)
	if err != nil {
		return nil, err
	}
	var logs []rpcLog
	if err := json.Unmarshal(res, &logs); err != nil {
		return nil, err
	}
	return logs, nil
}

// waitFreshEvent polls the reference RPC head until a block newer than
// lastSeen containing at least one USDC Transfer shows up. T0 is the
// instant we first observed the new head. Returns (0, "", zero) only
// when ctx is cancelled.
func waitFreshEvent(ctx context.Context, lastSeen uint64) (probeEvent, time.Time) {
	for {
		select {
		case <-ctx.Done():
			return probeEvent{}, time.Time{}
		default:
		}
		bn, err := headBlock()
		if err != nil {
			fmt.Printf("[sampler] head poll error: %s\n", sanitize(err))
			time.Sleep(2 * time.Second)
			continue
		}
		if bn > lastSeen {
			t0 := time.Now()
			logs, err := usdcTransfersInBlock(bn)
			if err != nil {
				fmt.Printf("[sampler] getLogs error: %s\n", sanitize(err))
				time.Sleep(time.Second)
				continue
			}
			if len(logs) > 0 {
				pick := logs[rand.Intn(len(logs))]
				if strings.HasPrefix(pick.TransactionHash, "0x") && len(pick.TransactionHash) == 66 && recipient(pick) != "" {
					return probeEvent{Block: bn, TxHash: strings.ToLower(pick.TransactionHash), Wallet: strings.ToLower(recipient(pick))}, t0
				}
			}
			// Rare on ETH mainnet: block without a USDC transfer. Skip it.
			lastSeen = bn
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

// bodyContains — deliberately parser-free detection: lowercase the raw
// response body and look for the tx hash substring. Immune to
// per-provider schema churn; no response shape is favoured.
func bodyContains(resp *http.Response, txHash string) (bool, error) {
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return false, err
	}
	if resp.StatusCode != 200 {
		return false, fmt.Errorf("status %d", resp.StatusCode)
	}
	return bytes.Contains(bytes.ToLower(raw), []byte(strings.ToLower(txHash))), nil
}

// sanitize strips anything URL-ish from provider errors before logging
// (the Alchemy key rides in its URL; never let it reach stdout/loghub).
func sanitize(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if i := strings.Index(s, "http"); i >= 0 {
		return s[:i] + "<url>"
	}
	return s
}

// ---------------------------------------------------------------------------
// Monthly quota guard (same design as indexing-freshness / rpc-keyed-latency).
// ---------------------------------------------------------------------------

type quotaGuard struct {
	mu     sync.Mutex
	month  string
	counts map[string]int64
}

var quota = &quotaGuard{counts: make(map[string]int64)}

func (q *quotaGuard) allow(p Provider) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	m := time.Now().UTC().Format("2006-01")
	if m != q.month {
		q.month = m
		q.counts = make(map[string]int64)
	}
	used := q.counts[p.Slug]
	ratio := float64(used) / float64(p.Budget)
	quotaUsedRatio.WithLabelValues(p.Slug).Set(ratio)
	if ratio >= 0.90 {
		return false
	}
	// Reserve the worst case for one event (full poll schedule).
	q.counts[p.Slug] = used + int64(len(pollSchedule))
	return true
}
