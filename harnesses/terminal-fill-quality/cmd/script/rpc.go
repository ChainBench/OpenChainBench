package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type rpcClient struct {
	url    string
	http   *http.Client
	calls  func()
	errors func()
	// Pacing: at most one call per minGap (RPC_RPS), so a burst of scans
	// never trips the provider's per-second limit.
	minGap time.Duration
	mu     sync.Mutex
	last   time.Time
}

func (c *rpcClient) pace() {
	if c.minGap <= 0 {
		return
	}
	c.mu.Lock()
	wait := time.Until(c.last.Add(c.minGap))
	if wait > 0 {
		time.Sleep(wait)
	}
	c.last = time.Now()
	c.mu.Unlock()
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

var errRateLimited = errors.New("rpc: rate limited")

func (c *rpcClient) call(ctx context.Context, method string, params []any, out any) error {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	for attempt := 0; attempt < 4; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		c.pace()
		c.calls()
		resp, err := c.http.Do(req)
		if err != nil {
			c.errors()
			time.Sleep(time.Duration(attempt+1) * time.Second)
			continue
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			c.errors()
			time.Sleep(time.Duration(2*(attempt+1)) * time.Second)
			continue
		}
		if resp.StatusCode/100 != 2 {
			c.errors()
			return fmt.Errorf("rpc %s: http %d: %s", method, resp.StatusCode, truncate(string(data), 160))
		}
		var env struct {
			Result json.RawMessage `json:"result"`
			Error  *rpcError       `json:"error"`
		}
		if err := json.Unmarshal(data, &env); err != nil {
			return fmt.Errorf("rpc %s: %w", method, err)
		}
		if env.Error != nil {
			if env.Error.Code == 429 || env.Error.Code == -32429 {
				c.errors()
				time.Sleep(time.Duration(2*(attempt+1)) * time.Second)
				continue
			}
			return fmt.Errorf("rpc %s: %d %s", method, env.Error.Code, env.Error.Message)
		}
		if out == nil || string(env.Result) == "null" {
			return nil
		}
		return json.Unmarshal(env.Result, out)
	}
	return errRateLimited
}

type sigInfo struct {
	Signature string          `json:"signature"`
	Slot      uint64          `json:"slot"`
	Err       json.RawMessage `json:"err"`
	BlockTime *int64          `json:"blockTime"`
}

func (s sigInfo) failed() bool { return len(s.Err) > 0 && string(s.Err) != "null" }

func (c *rpcClient) signatures(ctx context.Context, address string, limit int, until string) ([]sigInfo, error) {
	opts := map[string]any{"limit": limit, "commitment": "confirmed"}
	if until != "" {
		opts["until"] = until
	}
	var out []sigInfo
	err := c.call(ctx, "getSignaturesForAddress", []any{address, opts}, &out)
	return out, err
}

// Minimal jsonParsed transaction shape: account keys, balances, and the
// program ids of every top-level and inner instruction.
type parsedTx struct {
	Slot        uint64 `json:"slot"`
	BlockTime   *int64 `json:"blockTime"`
	Transaction struct {
		Message struct {
			AccountKeys []struct {
				Pubkey string `json:"pubkey"`
				Signer bool   `json:"signer"`
			} `json:"accountKeys"`
			Instructions []struct {
				ProgramID string `json:"programId"`
			} `json:"instructions"`
		} `json:"message"`
	} `json:"transaction"`
	Meta struct {
		Err               json.RawMessage `json:"err"`
		Fee               uint64          `json:"fee"`
		PreBalances       []uint64        `json:"preBalances"`
		PostBalances      []uint64        `json:"postBalances"`
		PreTokenBalances  []tokenBalance  `json:"preTokenBalances"`
		PostTokenBalances []tokenBalance  `json:"postTokenBalances"`
		InnerInstructions []struct {
			Instructions []struct {
				ProgramID string `json:"programId"`
			} `json:"instructions"`
		} `json:"innerInstructions"`
	} `json:"meta"`
}

type tokenBalance struct {
	AccountIndex  int    `json:"accountIndex"`
	Mint          string `json:"mint"`
	Owner         string `json:"owner"`
	UITokenAmount struct {
		Amount   string `json:"amount"`
		Decimals int    `json:"decimals"`
	} `json:"uiTokenAmount"`
}

func (b tokenBalance) raw() float64 {
	v, err := strconv.ParseFloat(b.UITokenAmount.Amount, 64)
	if err != nil {
		return math.NaN()
	}
	return v
}

func (c *rpcClient) transaction(ctx context.Context, sig string) (*parsedTx, error) {
	var out parsedTx
	err := c.call(ctx, "getTransaction", []any{sig, map[string]any{
		"encoding": "jsonParsed", "maxSupportedTransactionVersion": 1, "commitment": "confirmed",
	}}, &out)
	if err != nil {
		return nil, err
	}
	if len(out.Transaction.Message.AccountKeys) == 0 {
		return nil, nil
	}
	return &out, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// solPrice reads SOL/USD from Coinbase's public spot endpoint, falling
// back to Jupiter's lite price API; both keyless. Only used to size trades
// in USD and to pick the quote asset: every loss figure is a ratio in
// quote units and does not depend on it.
func solPrice(ctx context.Context, client *http.Client) (float64, error) {
	get := func(url string, out any) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			return fmt.Errorf("http %d", resp.StatusCode)
		}
		return json.NewDecoder(resp.Body).Decode(out)
	}
	var cb struct {
		Data struct {
			Amount string `json:"amount"`
		} `json:"data"`
	}
	if err := get("https://api.coinbase.com/v2/prices/SOL-USD/spot", &cb); err == nil {
		if p, err := strconv.ParseFloat(cb.Data.Amount, 64); err == nil && p > 0 {
			return p, nil
		}
	}
	var jup map[string]struct {
		USDPrice float64 `json:"usdPrice"`
	}
	if err := get("https://lite-api.jup.ag/price/v3?ids="+wsolMint, &jup); err != nil {
		return 0, err
	}
	if p := jup[wsolMint].USDPrice; p > 0 {
		return p, nil
	}
	return 0, errors.New("no SOL price")
}

// tokenPrices reads USD reference prices for up to 50 mints from Jupiter's
// lite price API (keyless). Missing mints are absent from the map.
func tokenPrices(ctx context.Context, client *http.Client, mints []string) (map[string]float64, error) {
	out := map[string]float64{}
	for i := 0; i < len(mints); i += 50 {
		batch := mints[i:min(i+50, len(mints))]
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://lite-api.jup.ag/price/v3?ids="+strings.Join(batch, ","), nil)
		if err != nil {
			return out, err
		}
		req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
		resp, err := client.Do(req)
		if err != nil {
			return out, err
		}
		var body map[string]struct {
			USDPrice float64 `json:"usdPrice"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil {
			return out, err
		}
		for m, v := range body {
			if v.USDPrice > 0 {
				out[m] = v.USDPrice
			}
		}
	}
	return out, nil
}
