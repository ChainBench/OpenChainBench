package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// integrity.go — bench 083 rpc-reliability, fixed-vector correctness
// checks. Every 5 minutes ONE chain (rotating through the set below)
// gets the same two questions asked of every provider serving it:
//
//   logs    — `eth_getLogs` for the chain's canonical USDC contract
//             over a 10-block window ending at tip-N. Completeness:
//             a provider silently dropping logs (or blocking the
//             method, or gating the depth behind a paid tier) shows
//             up against the cross-provider majority count.
//   balance — `eth_getBalance` of a fixed well-known address at the
//             same tip-N block. Consistency: the hex answer must be
//             byte-identical across providers; the comparison works
//             whether or not the balance is non-zero.
//
// Anti-gaming: N rotates daily over {20, 30, 40, 50, 60} blocks so a
// provider cannot special-case a fixed range, and every request id
// rotates (same edge-cache defeat as the latency probe). All depths
// stay far inside non-archive territory so pruned-but-honest nodes
// are never penalized; a provider that gates even 60-blocks-deep data
// behind a key (observed live: publicnode -32602 "Archive requests
// require a personal token") is emitting exactly the signal this
// bench exists to record.
//
// Errors ARE signal: result="error" on rpc_integrity_check_total is
// counted as an incident by the spec, because "method blocked" and
// "depth gated" are reliability failures from the caller's seat.

const (
	integrityInterval    = 5 * time.Minute
	integrityTimeout     = 15 * time.Second
	// integrityCallSpacing: sequential per-provider spacing; meowrpc
	// 429s on rapid bursts (same lesson as archive.go).
	integrityCallSpacing = 1500 * time.Millisecond
	// integrityLogsSpan: width of the getLogs window, in blocks.
	integrityLogsSpan uint64 = 10
	// integrityBalanceAddr: same well-known address the archive loop
	// uses (Vitalik). The check compares answers across providers
	// byte-for-byte, so it is divergence we measure, not the value.
	integrityBalanceAddr = archiveTestAddr
)

// integrityVectors maps chain slug -> canonical USDC contract used as
// the fixed eth_getLogs vector. Only chains with a heavily traded
// canonical USDC participate (a quiet contract would return 0 logs
// everywhere and the completeness check would be vacuous). Native
// Circle deployments except BNB (Binance-peg, still the busiest
// USDC-family contract there).
var integrityVectors = map[string]string{
	"ethereum":  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	"arbitrum":  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
	"optimism":  "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
	"base":      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	"polygon":   "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
	"bnb":       "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
	"avalanche": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
}

// integrityOffset returns today's tip-N base depth: 20 + 10*(day%5),
// i.e. {20, 30, 40, 50, 60}, rotating at UTC midnight.
func integrityOffset() uint64 {
	day := uint64(time.Now().UTC().Unix() / 86400)
	return 20 + 10*(day%5)
}

// StartIntegrityLoop rotates through the vector-equipped chains, one
// chain per 5-minute tick. Non-blocking; spawns its own goroutine.
func StartIntegrityLoop(ctx context.Context) {
	var targets []Chain
	for _, c := range chains() {
		if c.Kind == "" && integrityVectors[c.Slug] != "" {
			targets = append(targets, c)
		}
	}
	if len(targets) == 0 {
		return
	}
	initIntegrityMetrics(targets)

	go func() {
		// Let the latency loop populate chainTips first: the vector
		// block range is derived from the cross-provider tip.
		select {
		case <-ctx.Done():
			return
		case <-time.After(90 * time.Second):
		}
		i := 0
		integrityTick(ctx, targets[i%len(targets)])
		i++
		t := time.NewTicker(integrityInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				integrityTick(ctx, targets[i%len(targets)])
				i++
			}
		}
	}()
}

type integrityObs struct {
	p       Provider
	logsN   int
	logsErr error
	balHex  string
	balErr  error
}

func integrityTick(ctx context.Context, c Chain) {
	tip := tips.get(c.Slug)
	off := integrityOffset()
	if tip <= off+integrityLogsSpan {
		fmt.Printf("[integrity/%s] no tip yet (tip=%d), skipping round\n", c.Slug, tip)
		return
	}
	to := tip - off
	from := to - (integrityLogsSpan - 1)

	obs := make([]integrityObs, 0, len(c.Providers))
	for _, p := range c.Providers {
		o := integrityObs{p: p}
		o.logsN, o.logsErr = fetchLogsCount(ctx, p.URL, integrityVectors[c.Slug], from, to)
		if !integritySleep(ctx) {
			return
		}
		o.balHex, o.balErr = fetchBalanceHex(ctx, p.URL, integrityBalanceAddr, to)
		obs = append(obs, o)
		if !integritySleep(ctx) {
			return
		}
	}

	// Logs completeness: strict majority of the successful counts.
	logsCounts := make(map[int]int)
	for _, o := range obs {
		if o.logsErr == nil {
			logsCounts[o.logsN]++
		}
	}
	majLogs, logsQuorum := majority(logsCounts)
	for _, o := range obs {
		switch {
		case o.logsErr != nil:
			rpcLogsCount.DeleteLabelValues(o.p.Slug, c.Slug, currentRegion)
			rpcIntegrityCheck.WithLabelValues(o.p.Slug, c.Slug, currentRegion, "logs", "error").Inc()
			fmt.Printf("[integrity/%s/%s] logs range=%d-%d err=%v\n", c.Slug, o.p.Slug, from, to, o.logsErr)
		case logsQuorum && o.logsN != majLogs:
			rpcLogsCount.WithLabelValues(o.p.Slug, c.Slug, currentRegion).Set(float64(o.logsN))
			rpcLogsDisagreement.WithLabelValues(o.p.Slug, c.Slug, currentRegion).Inc()
			rpcIntegrityCheck.WithLabelValues(o.p.Slug, c.Slug, currentRegion, "logs", "disagree").Inc()
			fmt.Printf("[integrity/%s/%s] logs DISAGREE got=%d majority=%d range=%d-%d\n", c.Slug, o.p.Slug, o.logsN, majLogs, from, to)
		default:
			// No >=2 quorum this round (too few successes) also lands
			// here: a lone answer is unverifiable, not wrong.
			rpcLogsCount.WithLabelValues(o.p.Slug, c.Slug, currentRegion).Set(float64(o.logsN))
			rpcIntegrityCheck.WithLabelValues(o.p.Slug, c.Slug, currentRegion, "logs", "ok").Inc()
			fmt.Printf("[integrity/%s/%s] logs ok count=%d range=%d-%d\n", c.Slug, o.p.Slug, o.logsN, from, to)
		}
	}

	// State consistency: strict majority of the raw hex answers.
	balCounts := make(map[string]int)
	for _, o := range obs {
		if o.balErr == nil {
			balCounts[o.balHex]++
		}
	}
	majBal, balQuorum := majority(balCounts)
	for _, o := range obs {
		switch {
		case o.balErr != nil:
			rpcIntegrityCheck.WithLabelValues(o.p.Slug, c.Slug, currentRegion, "balance", "error").Inc()
			fmt.Printf("[integrity/%s/%s] balance block=%d err=%v\n", c.Slug, o.p.Slug, to, o.balErr)
		case balQuorum && o.balHex != majBal:
			rpcStateDisagreement.WithLabelValues(o.p.Slug, c.Slug, currentRegion).Inc()
			rpcIntegrityCheck.WithLabelValues(o.p.Slug, c.Slug, currentRegion, "balance", "disagree").Inc()
			fmt.Printf("[integrity/%s/%s] balance DISAGREE got=%s majority=%s block=%d\n", c.Slug, o.p.Slug, o.balHex, majBal, to)
		default:
			rpcIntegrityCheck.WithLabelValues(o.p.Slug, c.Slug, currentRegion, "balance", "ok").Inc()
			fmt.Printf("[integrity/%s/%s] balance ok block=%d\n", c.Slug, o.p.Slug, to)
		}
	}
}

func integritySleep(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(integrityCallSpacing):
		return true
	}
}

// majority returns the value backed by >=2 votes and strictly more
// than any competing value; ok=false when no such strict majority
// exists (all-distinct answers, or a tie).
func majority[T comparable](counts map[T]int) (T, bool) {
	var best T
	bestN, secondN := 0, 0
	for v, n := range counts {
		if n > bestN {
			best, secondN, bestN = v, bestN, n
		} else if n > secondN {
			secondN = n
		}
	}
	return best, bestN >= 2 && bestN > secondN
}

func fetchLogsCount(ctx context.Context, url, addr string, from, to uint64) (int, error) {
	body := fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"eth_getLogs","params":[{"fromBlock":"0x%x","toBlock":"0x%x","address":"%s"}],"id":%d}`,
		from, to, addr, time.Now().UnixNano(),
	)
	raw, err := integrityPost(ctx, url, body)
	if err != nil {
		return 0, err
	}
	var r rpcBlockEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, err
	}
	if r.Error != nil {
		return 0, fmt.Errorf("rpc %d: %s", r.Error.Code, r.Error.Message)
	}
	var logs []json.RawMessage
	if err := json.Unmarshal(r.Result, &logs); err != nil {
		return 0, fmt.Errorf("non-array result")
	}
	return len(logs), nil
}

func fetchBalanceHex(ctx context.Context, url, addr string, block uint64) (string, error) {
	body := fmt.Sprintf(
		`{"jsonrpc":"2.0","method":"eth_getBalance","params":["%s","0x%x"],"id":%d}`,
		addr, block, time.Now().UnixNano(),
	)
	raw, err := integrityPost(ctx, url, body)
	if err != nil {
		return "", err
	}
	var r rpcEnvelope
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", err
	}
	if r.Error != nil {
		return "", fmt.Errorf("rpc %d: %s", r.Error.Code, r.Error.Message)
	}
	if r.Result == "" {
		return "", fmt.Errorf("empty result")
	}
	return r.Result, nil
}

func integrityPost(ctx context.Context, url, body string) ([]byte, error) {
	c, cancel := context.WithTimeout(ctx, integrityTimeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, "POST", url, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	client := &http.Client{Timeout: integrityTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, fmt.Errorf("http %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// initIntegrityMetrics zero-initializes every counter in the vector
// matrix so the bench's `increase()` queries read 0, not absent, for
// clean providers.
func initIntegrityMetrics(targets []Chain) {
	for _, c := range targets {
		for _, p := range c.Providers {
			for _, check := range []string{"logs", "balance"} {
				for _, result := range []string{"ok", "error", "disagree"} {
					rpcIntegrityCheck.WithLabelValues(p.Slug, c.Slug, currentRegion, check, result).Add(0)
				}
			}
			rpcLogsDisagreement.WithLabelValues(p.Slug, c.Slug, currentRegion).Add(0)
			rpcStateDisagreement.WithLabelValues(p.Slug, c.Slug, currentRegion).Add(0)
		}
	}
}
