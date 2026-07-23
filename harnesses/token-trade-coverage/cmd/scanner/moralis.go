package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Moralis has two hosts: a Solana gateway with its own routes and the
// EVM deep-index API with shared /erc20 routes.
const (
	moralisSolanaBase = "https://solana-gateway.moralis.io"
	moralisEVMBase    = "https://deep-index.moralis.io/api/v2.2"
)

type moralisResp struct {
	Cursor string `json:"cursor"`
	Result []struct {
		TransactionHash string `json:"transactionHash"`
		ExchangeName    string `json:"exchangeName"`
		PairAddress     string `json:"pairAddress"`
	} `json:"result"`
}

// fetchMoralis returns (trade count, distinct DEX venues, error).
// Moralis paginates via `cursor` on both hosts; page size caps at 100.
func fetchMoralis(
	ctx context.Context,
	client *http.Client,
	apiKey string,
	tok Token,
	windowStart, windowEnd int64,
) (int, int, error) {
	if apiKey == "" {
		return 0, 0, fmt.Errorf("MORALIS_API_KEY not set")
	}

	fromISO := time.Unix(windowStart/1000, 0).UTC().Format(time.RFC3339)
	toISO := time.Unix(windowEnd/1000, 0).UTC().Format(time.RFC3339)

	var (
		total    int
		cursor   string
		dexSet   = map[string]struct{}{}
		hashSet  = map[string]struct{}{}
		maxPages = 100
	)

	for page := 0; page < maxPages; page++ {
		var reqURL string
		if tok.Chain == "solana" {
			base := fmt.Sprintf("%s/token/mainnet/%s/swaps", moralisSolanaBase, tok.Address)
			u, _ := url.Parse(base)
			q := u.Query()
			q.Set("fromDate", fromISO)
			q.Set("toDate", toISO)
			q.Set("order", "ASC")
			q.Set("limit", "100")
			q.Set("transactionTypes", "buy,sell")
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			u.RawQuery = q.Encode()
			reqURL = u.String()
		} else {
			chain := moralisEVMChain(tok.Chain)
			if chain == "" {
				return 0, 0, fmt.Errorf("moralis: unsupported chain %s", tok.Chain)
			}
			base := fmt.Sprintf("%s/erc20/%s/swaps", moralisEVMBase, tok.Address)
			u, _ := url.Parse(base)
			q := u.Query()
			q.Set("chain", chain)
			q.Set("fromDate", fromISO)
			q.Set("toDate", toISO)
			q.Set("order", "ASC")
			q.Set("limit", "100")
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			u.RawQuery = q.Encode()
			reqURL = u.String()
		}

		req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
		if err != nil {
			return total, len(dexSet), err
		}
		req.Header.Set("X-API-Key", apiKey)
		req.Header.Set("Accept", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			return total, len(dexSet), err
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return total, len(dexSet), err
		}
		if resp.StatusCode >= 300 {
			return total, len(dexSet), fmt.Errorf("moralis http %d: %s", resp.StatusCode, truncate(string(body), 200))
		}
		var r moralisResp
		if err := json.Unmarshal(body, &r); err != nil {
			return total, len(dexSet), fmt.Errorf("moralis parse: %w", err)
		}
		for _, t := range r.Result {
			if _, seen := hashSet[t.TransactionHash]; seen {
				continue
			}
			hashSet[t.TransactionHash] = struct{}{}
			total++
			if t.ExchangeName != "" {
				dexSet[t.ExchangeName] = struct{}{}
			}
		}
		if r.Cursor == "" || len(r.Result) == 0 {
			break
		}
		cursor = r.Cursor
		time.Sleep(50 * time.Millisecond)
	}
	return total, len(dexSet), nil
}

func moralisEVMChain(chain string) string {
	switch chain {
	case "ethereum":
		return "0x1"
	case "bsc":
		return "0x38"
	case "base":
		return "0x2105"
	}
	return ""
}
