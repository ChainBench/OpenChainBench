package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const mobulaBase = "https://api.mobula.io/api/2/trades/filters"

// mobulaResp is the minimal envelope we care about: we only need the
// count (via len(data)) and the DEX per row for coverage-breadth. Full
// trade objects are 30+ fields we intentionally ignore.
//
// Field names track Mobula's `/api/2/trades/filters` response as of
// 2026-07-23. `transactionHash` doubles as the dedup key across
// paginated pages. DEX identity comes from `platform.name` when the
// venue is a mapped protocol (Raydium, Uniswap v3, …); otherwise the
// pool address in `marketAddress` acts as a fallback venue proxy.
type mobulaTrade struct {
	TransactionHash string `json:"transactionHash"`
	Platform        *struct {
		Name string `json:"name"`
	} `json:"platform"`
	MarketAddress string `json:"marketAddress"`
}

type mobulaResp struct {
	Data       []mobulaTrade `json:"data"`
	Pagination struct {
		HasMore    bool   `json:"hasMore"`
		NextCursor string `json:"nextCursor"`
	} `json:"pagination"`
}

// fetchMobula returns (trade count, distinct DEXs, error). Paginates
// via cursor until either exhausted or the safety cap is hit.
func fetchMobula(
	ctx context.Context,
	client *http.Client,
	apiKey string,
	tok Token,
	windowStart, windowEnd int64,
	maxPages int,
) (int, int, error) {
	if apiKey == "" {
		return 0, 0, fmt.Errorf("MOBULA_API_KEY not set")
	}
	if maxPages <= 0 {
		maxPages = 20
	}
	var (
		total   int
		cursor  string
		dexSet  = map[string]struct{}{}
		hashSet = map[string]struct{}{}
	)
	for page := 0; page < maxPages; page++ {
		u, _ := url.Parse(mobulaBase)
		q := u.Query()
		q.Set("blockchain", mobulaChainName(tok.Chain))
		q.Set("tokenAddress", tok.Address)
		q.Set("from", strconv.FormatInt(windowStart, 10))
		q.Set("to", strconv.FormatInt(windowEnd, 10))
		q.Set("limit", "5000")
		q.Set("sortOrder", "asc")
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		u.RawQuery = q.Encode()

		req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		if err != nil {
			return total, len(dexSet), err
		}
		req.Header.Set("Authorization", apiKey)
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
			return total, len(dexSet), fmt.Errorf("mobula http %d: %s", resp.StatusCode, truncate(string(body), 200))
		}
		var r mobulaResp
		if err := json.Unmarshal(body, &r); err != nil {
			return total, len(dexSet), fmt.Errorf("mobula parse: %w", err)
		}
		for _, t := range r.Data {
			// Dedupe by tx hash across pages. Providers occasionally
			// return the same hash on consecutive pages when a cursor
			// resets under the hood.
			if _, seen := hashSet[t.TransactionHash]; seen {
				continue
			}
			hashSet[t.TransactionHash] = struct{}{}
			total++
			// DEX identity: prefer `platform.name` (mapped protocol),
			// fall back to `marketAddress` (raw pool address) so a
			// venue with no mapped platform still contributes one
			// distinct venue to the coverage-breadth metric instead
			// of being dropped silently.
			if t.Platform != nil && t.Platform.Name != "" {
				dexSet[t.Platform.Name] = struct{}{}
			} else if t.MarketAddress != "" {
				dexSet[t.MarketAddress] = struct{}{}
			}
		}
		if !r.Pagination.HasMore || r.Pagination.NextCursor == "" || len(r.Data) == 0 {
			break
		}
		cursor = r.Pagination.NextCursor
		// Cursor pages back-to-back can trip provider rate limits; a
		// short breather keeps the fetch inside its budget without
		// starving the cadence.
		time.Sleep(50 * time.Millisecond)
	}
	return total, len(dexSet), nil
}

// mobulaChainName maps OCB canonical chain slug → Mobula chain param
// value. Kept centralised so the mapping is auditable in one place.
func mobulaChainName(chain string) string {
	switch chain {
	case "solana":
		return "Solana"
	case "ethereum":
		return "Ethereum"
	case "bsc":
		return "BNB Smart Chain (BEP20)"
	case "base":
		return "Base"
	case "stellar":
		return "Stellar"
	default:
		return chain
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
