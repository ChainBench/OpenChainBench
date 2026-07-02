package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Minimal JSON-RPC client over a rotating pool of free public Polygon RPCs.
// Free tiers throttle and cap eth_getLogs ranges, so every call retries with
// backoff and rotates to the next URL on failure.

type rpcClient struct {
	urls   []string
	http   *http.Client
	mu     sync.Mutex
	cursor int

	tsMu    sync.Mutex
	tsCache map[uint64]int64 // block number -> unix timestamp
}

func newRPCClient(urls []string) *rpcClient {
	return &rpcClient{
		urls:    urls,
		http:    &http.Client{Timeout: 45 * time.Second},
		tsCache: map[uint64]int64{},
	}
}

type rpcLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	TxHash      string   `json:"transactionHash"`
	Removed     bool     `json:"removed"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (c *rpcClient) nextURL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	u := c.urls[c.cursor%len(c.urls)]
	c.cursor++
	return u
}

// call issues one JSON-RPC request, rotating across URLs with backoff.
// Up to 3 attempts per URL across the pool.
func (c *rpcClient) call(ctx context.Context, method string, params any, out any) error {
	var lastErr error
	attempts := 3 * len(c.urls)
	backoff := 2 * time.Second
	for i := 0; i < attempts; i++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		url := c.nextURL()
		err := c.callOne(ctx, url, method, params, out)
		if err == nil {
			return nil
		}
		lastErr = err
		log.Printf("[rpc] %s on %s failed (attempt %d/%d): %v", method, url, i+1, attempts, err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
	return lastErr
}

func (c *rpcClient) callOne(ctx context.Context, url, method string, params any, out any) error {
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.http.Do(req)
	if err != nil {
		kind := "http"
		if errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "Client.Timeout") {
			kind = "timeout"
		}
		rpcErrors.WithLabelValues(kind).Inc()
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		rpcErrors.WithLabelValues("http").Inc()
		return err
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		rpcErrors.WithLabelValues("rpc_error").Inc()
		return fmt.Errorf("throttled (429)")
	}
	if resp.StatusCode != http.StatusOK {
		rpcErrors.WithLabelValues("http").Inc()
		return fmt.Errorf("http %d: %.120s", resp.StatusCode, raw)
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  *rpcError       `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		rpcErrors.WithLabelValues("decode").Inc()
		return fmt.Errorf("decode: %v (%.120s)", err, raw)
	}
	if envelope.Error != nil {
		rpcErrors.WithLabelValues("rpc_error").Inc()
		return fmt.Errorf("rpc %d: %s", envelope.Error.Code, envelope.Error.Message)
	}
	if envelope.Result == nil || string(envelope.Result) == "null" {
		rpcErrors.WithLabelValues("decode").Inc()
		return fmt.Errorf("null result")
	}
	return json.Unmarshal(envelope.Result, out)
}

func (c *rpcClient) blockNumber(ctx context.Context) (uint64, error) {
	var hexNum string
	if err := c.call(ctx, "eth_blockNumber", []any{}, &hexNum); err != nil {
		return 0, err
	}
	return parseHexUint(hexNum)
}

// blockTimestamp returns the unix timestamp of a block, cached forever
// (Polygon blocks are final well before we read them).
func (c *rpcClient) blockTimestamp(ctx context.Context, num uint64) (int64, error) {
	c.tsMu.Lock()
	if ts, ok := c.tsCache[num]; ok {
		c.tsMu.Unlock()
		return ts, nil
	}
	c.tsMu.Unlock()

	var blk struct {
		Timestamp string `json:"timestamp"`
	}
	if err := c.call(ctx, "eth_getBlockByNumber", []any{hexUint(num), false}, &blk); err != nil {
		return 0, err
	}
	tsU, err := parseHexUint(blk.Timestamp)
	if err != nil {
		return 0, err
	}
	ts := int64(tsU)
	c.tsMu.Lock()
	if len(c.tsCache) > 50000 { // bound memory over months of uptime
		c.tsCache = map[uint64]int64{}
	}
	c.tsCache[num] = ts
	c.tsMu.Unlock()
	return ts, nil
}

func (c *rpcClient) getLogs(ctx context.Context, from, to uint64, addresses []string, topics []any) ([]rpcLog, error) {
	filter := map[string]any{
		"fromBlock": hexUint(from),
		"toBlock":   hexUint(to),
		"address":   addresses,
	}
	if topics != nil {
		filter["topics"] = topics
	}
	var logs []rpcLog
	if err := c.call(ctx, "eth_getLogs", []any{filter}, &logs); err != nil {
		return nil, err
	}
	return logs, nil
}

// blockAtTime binary-searches the chain for the first block at or after the
// target unix timestamp. ~25 timestamp lookups, all cached.
func (c *rpcClient) blockAtTime(ctx context.Context, target int64, head uint64) (uint64, error) {
	lo, hi := uint64(1), head
	for lo < hi {
		mid := (lo + hi) / 2
		ts, err := c.blockTimestamp(ctx, mid)
		if err != nil {
			return 0, err
		}
		if ts < target {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo, nil
}

func hexUint(n uint64) string { return "0x" + strconv.FormatUint(n, 16) }

func parseHexUint(s string) (uint64, error) {
	return strconv.ParseUint(strings.TrimPrefix(s, "0x"), 16, 64)
}
