package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Minimal JSON-RPC client over a list of endpoints. A call tries each
// endpoint in order and settles on the first that answers; a failing
// endpoint is retried on the next call, so a public gateway that rate
// limits for a minute does not pin the chain on its fallback for good.
type rpcClient struct {
	urls   []string
	http   *http.Client
	gap    time.Duration
	slug   string
	lastOK int // index of the endpoint that answered last
}

func newRPCClient(slug string, urls []string, gap time.Duration) *rpcClient {
	return &rpcClient{urls: urls, http: &http.Client{Timeout: 45 * time.Second}, gap: gap, slug: slug}
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

var errRangeTooWide = errors.New("range too wide")

// call runs one JSON-RPC method against the endpoints, preferring the one
// that answered last. errRangeTooWide is returned as-is so the caller can
// shrink its block window instead of switching endpoint.
func (c *rpcClient) call(ctx context.Context, method string, params any, out any) error {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	var lastErr error
	order := make([]int, 0, len(c.urls))
	order = append(order, c.lastOK)
	for i := range c.urls {
		if i != c.lastOK {
			order = append(order, i)
		}
	}
	for _, i := range order {
		url := c.urls[i]
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "OpenChainBench-bridge-flows/1.0 (+https://openchainbench.com/benchmarks/usdc-corridor-flows)")
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			rpcCalls.WithLabelValues(c.slug, hostOf(url), "transport").Inc()
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("%s: http %d", hostOf(url), resp.StatusCode)
			rpcCalls.WithLabelValues(c.slug, hostOf(url), "http_"+strconv.Itoa(resp.StatusCode)).Inc()
			continue
		}
		var env struct {
			Result json.RawMessage `json:"result"`
			Error  *rpcError       `json:"error"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			lastErr = fmt.Errorf("%s: decode: %w", hostOf(url), err)
			rpcCalls.WithLabelValues(c.slug, hostOf(url), "decode").Inc()
			continue
		}
		if env.Error != nil {
			msg := strings.ToLower(env.Error.Message)
			// Every public gateway words its block-range cap differently.
			if strings.Contains(msg, "range") || strings.Contains(msg, "too many") || strings.Contains(msg, "limit") || strings.Contains(msg, "exceed") || strings.Contains(msg, "10000") {
				rpcCalls.WithLabelValues(c.slug, hostOf(url), "range").Inc()
				c.lastOK = i
				return errRangeTooWide
			}
			lastErr = fmt.Errorf("%s: rpc %d %s", hostOf(url), env.Error.Code, env.Error.Message)
			rpcCalls.WithLabelValues(c.slug, hostOf(url), "rpc_error").Inc()
			continue
		}
		if err := json.Unmarshal(env.Result, out); err != nil {
			lastErr = fmt.Errorf("%s: result: %w", hostOf(url), err)
			rpcCalls.WithLabelValues(c.slug, hostOf(url), "decode").Inc()
			continue
		}
		rpcCalls.WithLabelValues(c.slug, hostOf(url), "ok").Inc()
		c.lastOK = i
		if c.gap > 0 {
			time.Sleep(c.gap)
		}
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("no endpoint")
	}
	return lastErr
}

func hostOf(url string) string {
	u := strings.TrimPrefix(strings.TrimPrefix(url, "https://"), "http://")
	if i := strings.IndexByte(u, '/'); i > 0 {
		u = u[:i]
	}
	return u
}

func (c *rpcClient) blockNumber(ctx context.Context) (int64, error) {
	var hex string
	if err := c.call(ctx, "eth_blockNumber", []any{}, &hex); err != nil {
		return 0, err
	}
	return parseHexInt(hex)
}

// blockTime returns the unix timestamp of a block.
func (c *rpcClient) blockTime(ctx context.Context, n int64) (int64, error) {
	var b struct {
		Timestamp string `json:"timestamp"`
	}
	if err := c.call(ctx, "eth_getBlockByNumber", []any{"0x" + strconv.FormatInt(n, 16), false}, &b); err != nil {
		return 0, err
	}
	if b.Timestamp == "" {
		return 0, fmt.Errorf("block %d: no timestamp", n)
	}
	return parseHexInt(b.Timestamp)
}

type ethLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	TxHash      string   `json:"transactionHash"`
	LogIndex    string   `json:"logIndex"`
	Removed     bool     `json:"removed"`
}

func (c *rpcClient) getLogs(ctx context.Context, from, to int64, addresses []string, topics [][]string) ([]ethLog, error) {
	var logs []ethLog
	filter := map[string]any{
		"fromBlock": "0x" + strconv.FormatInt(from, 16),
		"toBlock":   "0x" + strconv.FormatInt(to, 16),
		"address":   addresses,
		"topics":    topics,
	}
	if err := c.call(ctx, "eth_getLogs", []any{filter}, &logs); err != nil {
		return nil, err
	}
	return logs, nil
}

func parseHexInt(s string) (int64, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "0x")
	if s == "" {
		return 0, errors.New("empty hex")
	}
	v, err := strconv.ParseInt(s, 16, 64)
	if err != nil {
		return 0, err
	}
	return v, nil
}
