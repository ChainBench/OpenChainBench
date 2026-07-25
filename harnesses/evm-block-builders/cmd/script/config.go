package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Endpoints. All public, keyless, verified live at bench inception
// (2026-07-14). Every URL is env-overridable without a rebuild so a
// flaky public endpoint can be swapped from the deploy env.
//
// publicnode 403s default Go/Python User-Agents (bench 067 lesson), so
// EVERY outbound HTTP request and WS dial in this harness sends
// harnessUserAgent - see newRequest and the WS dial headers in
// arb_feed.go / base_flashblocks.go.

const (
	defaultEthRPC          = "https://ethereum-rpc.publicnode.com"
	defaultArbRPC          = "https://arbitrum-one-rpc.publicnode.com"
	defaultBaseRPC         = "https://base-rpc.publicnode.com"
	defaultArbFeedURL      = "wss://arb1.arbitrum.io/feed"
	defaultBaseFlashblocks = "wss://mainnet.flashblocks.base.org/ws"

	// Browser-prefixed but honest: identifies the harness while passing
	// UA-based bot filters (publicnode 403s bare Go-http-client UAs).
	harnessUserAgent = "Mozilla/5.0 (compatible; OpenChainBench-harness/1.0; +https://openchainbench.com)"

	// ETH mainnet slot time. One poll per slot samples ~every block; the
	// gap-backfill in builders.go covers the occasional missed one.
	ethPollInterval = 12 * time.Second

	// Relay bidtrace APIs are rate-limited and slow-moving (1 payload per
	// 12s slot at most); 5 min polls with limit=50 never miss a slot.
	relayPollInterval = 5 * time.Minute

	// L2 head pollers. 300ms against publicnode is comfortably inside the
	// public rate limits (verified live) and fine-grained enough to
	// resolve a ~100ms soft-conf lag.
	l2HeadPollInterval = 300 * time.Millisecond
)

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func ethRPCURL() string  { return envDefault("ETH_RPC_URL", defaultEthRPC) }
func arbRPCURL() string  { return envDefault("ARB_RPC_URL", defaultArbRPC) }
func baseRPCURL() string { return envDefault("BASE_RPC_URL", defaultBaseRPC) }
func arbFeedURL() string {
	return envDefault("ARB_FEED_URL", defaultArbFeedURL)
}
func baseFlashblocksURL() string {
	return envDefault("BASE_FLASHBLOCKS_URL", defaultBaseFlashblocks)
}

// listenAddr defaults to :2112 - OCB convention, scraped by the shared
// Prometheus. We deliberately ignore $PORT so a platform-injected public
// port doesn't move the listener away from the address Prom expects.
// METRICS_ADDR exists for local dev where another harness holds 2112.
func listenAddr() string { return envDefault("METRICS_ADDR", ":2112") }

var httpClient = &http.Client{Timeout: 15 * time.Second}

// newRequest builds an *http.Request with the harness User-Agent set.
func newRequest(method, url string, body []byte) (*http.Request, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", harnessUserAgent)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// jsonRPCCall does a single JSON-RPC 2.0 request and unmarshals the
// `result` field into out.
func jsonRPCCall(url, method string, params []any, out any) error {
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	if err != nil {
		return err
	}
	req, err := newRequest(http.MethodPost, url, payload)
	if err != nil {
		return err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("%s: HTTP %d: %s", method, resp.StatusCode, string(body))
	}
	var envl struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envl); err != nil {
		return fmt.Errorf("%s: decode: %w", method, err)
	}
	if envl.Error != nil {
		return fmt.Errorf("%s: rpc error %d: %s", method, envl.Error.Code, envl.Error.Message)
	}
	if envl.Result == nil {
		return fmt.Errorf("%s: empty result", method)
	}
	return json.Unmarshal(envl.Result, out)
}

// blockNumber fetches the current head number via eth_blockNumber.
func blockNumber(url string) (int64, error) {
	var hexNum string
	if err := jsonRPCCall(url, "eth_blockNumber", []any{}, &hexNum); err != nil {
		return 0, err
	}
	n := parseHexInt64(hexNum)
	if n == 0 {
		return 0, fmt.Errorf("eth_blockNumber: unparseable %q", hexNum)
	}
	return n, nil
}

func parseHexInt64(s string) int64 {
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		return 0
	}
	n, _ := strconv.ParseInt(s, 16, 64)
	return n
}
