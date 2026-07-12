package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Providers: public no-key MEV-protection gateways, one row per
// (provider, chain). Cohort verified live 2026-07-12:
//   - SecureRPC (Manifold) probed dead 2026-07-10.
//   - Blink (ex Merkle): blinklabs.xyz host on Ethereum (the legacy
//     eth.merkle.io alias rate-limits harder); on Base and BSC the
//     merkle.io hosts are the only keyless surface Blink exposes
//     (base/bsc.blinklabs.xyz do not resolve as of 2026-07-12).
//   - Flashbots Protect and MEV Blocker are Ethereum-only by design
//     (base.rpc.flashbots.net NXDOMAIN), which the coverage panel
//     surfaces rather than hides.
//   - bloXroute Protect documents ETH + BSC only; base.rpc.blxrbdn.com
//     is plain RPC without the Protect path, so it is not listed.
//   - PancakeSwap MEV Guard is powered by 48 Club; both rows are kept
//     because wallets see two different gateways with different edges.
var providers = []struct {
	Slug  string
	Chain string
	URL   string
}{
	{Slug: "flashbots", Chain: "ethereum", URL: "https://rpc.flashbots.net"},
	{Slug: "mevblocker", Chain: "ethereum", URL: "https://rpc.mevblocker.io"},
	{Slug: "blinklabs", Chain: "ethereum", URL: "https://ethereum.blinklabs.xyz"},
	{Slug: "bloxroute", Chain: "ethereum", URL: "https://eth-protect.rpc.blxrbdn.com"},
	{Slug: "blocksec", Chain: "ethereum", URL: "https://eth.rpc.blocksec.com"},
	{Slug: "blinklabs", Chain: "base", URL: "https://base.merkle.io"},
	{Slug: "blinklabs", Chain: "bsc", URL: "https://bsc.merkle.io"},
	{Slug: "bloxroute", Chain: "bsc", URL: "https://bsc.rpc.blxrbdn.com"},
	{Slug: "48club", Chain: "bsc", URL: "https://rpc.48.club"},
	{Slug: "pancakeswap", Chain: "bsc", URL: "https://bscrpc.pancakeswap.finance"},
	{Slug: "blocksec", Chain: "bsc", URL: "https://bsc.rpc.blocksec.com"},
}

// usdcByChain feeds the eth_call probe (balanceOf) with each chain's
// canonical USDC deployment so the simulation path exercises a real
// contract everywhere.
var usdcByChain = map[string]string{
	"ethereum": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	"base":     "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	"bsc":      "0x8AC76a51cC950d9822D68b83fE1Ad97B32Cd580d",
}

// walletMethods is the read set wallets fire constantly (balance
// refresh, gas estimation, simulation). One request per method per
// provider row per tick: 7 req/min/gateway/region, polite for gateways
// that rate-ban aggressive callers.
var walletMethods = []struct {
	Name   string
	Params func(chain string) []any
}{
	{"eth_chainId", func(string) []any { return []any{} }},
	{"eth_blockNumber", func(string) []any { return []any{} }},
	{"eth_gasPrice", func(string) []any { return []any{} }},
	{"eth_getBalance", func(string) []any { return []any{probeAddress, "latest"} }},
	{"eth_call", func(chain string) []any {
		return []any{map[string]string{"to": usdcByChain[chain], "data": balanceOfData}, "latest"}
	}},
	{"eth_estimateGas", func(string) []any {
		return []any{map[string]string{"from": probeAddress, "to": probeAddress, "value": "0x1"}}
	}},
	{"eth_feeHistory", func(string) []any { return []any{"0x5", "latest", []int{50}} }},
}

const (
	probeAddress  = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
	balanceOfData = "0x70a08231000000000000000000000000d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"

	tickInterval = 60 * time.Second
	methodGap    = 1500 * time.Millisecond
	probeTimeout = 10 * time.Second
)

type providerRow = struct {
	Slug  string
	Chain string
	URL   string
}

type rpcEnvelope struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func runProbeLoop(ctx context.Context) {
	client := &http.Client{Timeout: probeTimeout}
	t := time.NewTicker(tickInterval)
	defer t.Stop()
	tick(ctx, client)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick(ctx, client)
		}
	}
}

// tick probes every (provider, chain) row in parallel; within a row the
// methods stay sequential with methodGap between them, so each gateway
// still sees at most one request per 1.5s while the whole sweep fits
// inside the 60s tick regardless of cohort size.
func tick(ctx context.Context, client *http.Client) {
	var wg sync.WaitGroup
	for _, p := range providers {
		wg.Add(1)
		go func(p providerRow) {
			defer wg.Done()
			probeRow(ctx, client, p)
		}(p)
	}
	wg.Wait()
}

func probeRow(ctx context.Context, client *http.Client, p providerRow) {
	latencies := make([]float64, 0, len(walletMethods))
	supported := 0
	for _, m := range walletMethods {
		select {
		case <-ctx.Done():
			return
		default:
		}
		lat, result := call(ctx, client, p.URL, m.Name, m.Params(p.Chain))
		mevCallTotal.WithLabelValues(p.Slug, p.Chain, m.Name, currentRegion, result).Inc()
		if result == "ok" {
			supported++
			latencies = append(latencies, lat)
			mevMethodLatency.WithLabelValues(p.Slug, p.Chain, m.Name, currentRegion).Set(lat)
			mevMethodOK.WithLabelValues(p.Slug, p.Chain, m.Name, currentRegion).Set(1)
		} else {
			mevMethodOK.WithLabelValues(p.Slug, p.Chain, m.Name, currentRegion).Set(0)
		}
		time.Sleep(methodGap)
	}
	mevMethodsSupported.WithLabelValues(p.Slug, p.Chain, currentRegion).Set(float64(supported))
	if len(latencies) > 0 {
		sort.Float64s(latencies)
		median := latencies[len(latencies)/2]
		if len(latencies)%2 == 0 {
			median = (latencies[len(latencies)/2-1] + latencies[len(latencies)/2]) / 2
		}
		// Median across the methods the provider actually serves,
		// so coverage gaps (flashbots rejects eth_call) do not
		// poison the latency figure; coverage is its own metric.
		mevWalletLatency.WithLabelValues(p.Slug, p.Chain, currentRegion).Set(median)
		mevWalletLatencyHist.WithLabelValues(p.Slug, p.Chain, currentRegion).Observe(median)
	}
	fmt.Printf("[mev-protect][%s/%s][%s] supported=%d/%d median=%s\n",
		p.Slug, p.Chain, currentRegion, supported, len(walletMethods), fmtMedian(latencies))
}

func fmtMedian(l []float64) string {
	if len(l) == 0 {
		return "n/a"
	}
	return fmt.Sprintf("%.0fms", l[len(l)/2])
}

// call issues one JSON-RPC request with a rotating id (anti body-keyed
// edge cache, same rule as the RPC cluster probes) and classifies the
// outcome.
func call(ctx context.Context, client *http.Client, url, method string, params []any) (float64, string) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
		"id":      time.Now().UnixNano(),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, "request_build"
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-MevProtect/1.0 contact@mobula.io")

	start := time.Now()
	resp, err := client.Do(req)
	lat := float64(time.Since(start).Milliseconds())
	if err != nil {
		if ctx.Err() != nil {
			return lat, "canceled"
		}
		return lat, "network"
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode == http.StatusTooManyRequests {
		return lat, "throttled"
	}
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnauthorized {
		return lat, "blocked"
	}

	var env rpcEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return lat, "parse"
	}
	if env.Error != nil {
		if env.Error.Code == -32601 {
			return lat, "method_not_found"
		}
		return lat, "rpc_error"
	}
	if len(env.Result) == 0 || string(env.Result) == "null" {
		return lat, "empty"
	}
	return lat, "ok"
}
