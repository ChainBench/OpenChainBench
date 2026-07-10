package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"
)

// Providers: public no-key MEV-protection gateways on Ethereum mainnet.
// SecureRPC (Manifold) probed dead 2026-07-10; the legacy merkle.io
// hosts alias Blink's gateway behind a far more aggressive Cloudflare
// rate limit, so Blink is probed on the blinklabs.xyz host only.
var providers = []struct {
	Slug string
	URL  string
}{
	{Slug: "flashbots", URL: "https://rpc.flashbots.net"},
	{Slug: "mevblocker", URL: "https://rpc.mevblocker.io"},
	{Slug: "blinklabs", URL: "https://ethereum.blinklabs.xyz"},
}

// walletMethods is the read set wallets fire constantly (balance
// refresh, gas estimation, simulation). One request per method per
// provider per tick: 7 req/min/provider/region, polite for gateways
// that rate-ban aggressive callers.
var walletMethods = []struct {
	Name   string
	Params func() []any
}{
	{"eth_chainId", func() []any { return []any{} }},
	{"eth_blockNumber", func() []any { return []any{} }},
	{"eth_gasPrice", func() []any { return []any{} }},
	{"eth_getBalance", func() []any { return []any{probeAddress, "latest"} }},
	{"eth_call", func() []any {
		return []any{map[string]string{"to": usdcContract, "data": balanceOfData}, "latest"}
	}},
	{"eth_estimateGas", func() []any {
		return []any{map[string]string{"from": probeAddress, "to": probeAddress, "value": "0x1"}}
	}},
	{"eth_feeHistory", func() []any { return []any{"0x5", "latest", []int{50}} }},
}

const (
	probeAddress  = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
	usdcContract  = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
	balanceOfData = "0x70a08231000000000000000000000000d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"

	tickInterval = 60 * time.Second
	methodGap    = 1500 * time.Millisecond
	probeTimeout = 10 * time.Second
)

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

func tick(ctx context.Context, client *http.Client) {
	for _, p := range providers {
		latencies := make([]float64, 0, len(walletMethods))
		supported := 0
		for _, m := range walletMethods {
			select {
			case <-ctx.Done():
				return
			default:
			}
			lat, result := call(ctx, client, p.URL, m.Name, m.Params())
			mevCallTotal.WithLabelValues(p.Slug, m.Name, currentRegion, result).Inc()
			if result == "ok" {
				supported++
				latencies = append(latencies, lat)
				mevMethodLatency.WithLabelValues(p.Slug, m.Name, currentRegion).Set(lat)
				mevMethodOK.WithLabelValues(p.Slug, m.Name, currentRegion).Set(1)
			} else {
				mevMethodOK.WithLabelValues(p.Slug, m.Name, currentRegion).Set(0)
			}
			time.Sleep(methodGap)
		}
		mevMethodsSupported.WithLabelValues(p.Slug, currentRegion).Set(float64(supported))
		if len(latencies) > 0 {
			sort.Float64s(latencies)
			median := latencies[len(latencies)/2]
			if len(latencies)%2 == 0 {
				median = (latencies[len(latencies)/2-1] + latencies[len(latencies)/2]) / 2
			}
			// Median across the methods the provider actually serves,
			// so coverage gaps (flashbots rejects eth_call) do not
			// poison the latency figure; coverage is its own metric.
			mevWalletLatency.WithLabelValues(p.Slug, currentRegion).Set(median)
			mevWalletLatencyHist.WithLabelValues(p.Slug, currentRegion).Observe(median)
		}
		fmt.Printf("[mev-protect][%s][%s] supported=%d/%d median=%s\n",
			p.Slug, currentRegion, supported, len(walletMethods), fmtMedian(latencies))
	}
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
