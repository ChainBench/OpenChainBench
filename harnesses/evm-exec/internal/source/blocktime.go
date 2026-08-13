package source

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 20 * time.Second}

// HeadBlock returns the current head block number via eth_blockNumber.
func HeadBlock(ctx context.Context, rpcURL string) (uint64, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"method": "eth_blockNumber", "params": []any{},
	})
	var out struct {
		Result string             `json:"result"`
		Error  *struct{ Message string } `json:"error"`
	}
	if err := RpcPost(ctx, rpcURL, body, &out); err != nil {
		return 0, err
	}
	if out.Error != nil {
		return 0, fmt.Errorf("eth_blockNumber: %s", out.Error.Message)
	}
	return ParseHex64(out.Result)
}

// BlockTime fetches a block's unix timestamp via eth_getBlockByNumber(n, false).
func BlockTime(ctx context.Context, rpcURL string, blockNum uint64) (time.Time, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"method":  "eth_getBlockByNumber",
		"params":  []any{fmt.Sprintf("0x%x", blockNum), false},
	})
	var out struct {
		Result *struct {
			Timestamp string `json:"timestamp"`
		} `json:"result"`
		Error *struct{ Message string } `json:"error"`
	}
	if err := RpcPost(ctx, rpcURL, body, &out); err != nil {
		return time.Time{}, err
	}
	if out.Error != nil {
		return time.Time{}, fmt.Errorf("eth_getBlockByNumber: %s", out.Error.Message)
	}
	if out.Result == nil {
		return time.Time{}, fmt.Errorf("null block %d", blockNum)
	}
	ts, err := ParseHex64(out.Result.Timestamp)
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(int64(ts), 0).UTC(), nil
}

// ResolveBlockTag resolves an eth block tag ("finalized", "latest") to a block number.
func ResolveBlockTag(ctx context.Context, rpcURL, tag string) (uint64, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"method":  "eth_getBlockByNumber",
		"params":  []any{tag, false},
	})
	var out struct {
		Result *struct {
			Number string `json:"number"`
		} `json:"result"`
		Error *struct{ Message string } `json:"error"`
	}
	if err := RpcPost(ctx, rpcURL, body, &out); err != nil {
		return 0, err
	}
	if out.Error != nil {
		return 0, fmt.Errorf("eth_getBlockByNumber %s: %s", tag, out.Error.Message)
	}
	if out.Result == nil {
		return 0, fmt.Errorf("null block for tag %q", tag)
	}
	return ParseHex64(out.Result.Number)
}

// RpcPost marshals body, POSTs to rpcURL with Content-Type: application/json, decodes into dst.
func RpcPost(ctx context.Context, rpcURL string, body []byte, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rpcURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d from %s", resp.StatusCode, rpcURL)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

// ParseHex64 parses a 0x-prefixed or bare hex string to uint64.
func ParseHex64(s string) (uint64, error) {
	return strconv.ParseUint(strings.TrimPrefix(s, "0x"), 16, 64)
}
