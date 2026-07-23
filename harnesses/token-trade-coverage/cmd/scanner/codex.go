package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const codexURL = "https://graph.codex.io/graphql"

// codexResp: minimal envelope. Codex's `getTokenEvents` is cursor-paginated
// via the `cursor` string returned in each response.
type codexResp struct {
	Data struct {
		GetTokenEvents struct {
			Items []struct {
				TransactionHash string `json:"transactionHash"`
				EventType       string `json:"eventType"`
				ExchangeAddress string `json:"exchangeAddress"`
			} `json:"items"`
			Cursor string `json:"cursor"`
		} `json:"getTokenEvents"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// codexNetworkID maps OCB chain slug to Codex's numeric networkId.
// Same table as in the reference TS impl.
func codexNetworkID(chain string) int {
	switch chain {
	case "solana":
		return 1399811149
	case "ethereum":
		return 1
	case "bsc":
		return 56
	case "base":
		return 8453
	}
	return 0
}

// fetchCodex returns (trade count, distinct exchanges, error). Uses
// standard API-key auth via `Authorization` header — the cookie-based
// JWT flow that lives in aggregator-head-lag is not used here because
// query volume is batch-historical, not live-subscribe.
func fetchCodex(
	ctx context.Context,
	client *http.Client,
	apiKey string,
	tok Token,
	windowStart, windowEnd int64,
) (int, int, error) {
	if apiKey == "" {
		return 0, 0, fmt.Errorf("CODEX_API_KEY not set")
	}
	networkID := codexNetworkID(tok.Chain)
	if networkID == 0 {
		return 0, 0, fmt.Errorf("codex: unsupported chain %s", tok.Chain)
	}

	fromSec := windowStart / 1000
	toSec := windowEnd / 1000

	var (
		total    int
		cursor   string
		exchSet  = map[string]struct{}{}
		hashSet  = map[string]struct{}{}
		maxPages = 50
	)

	for page := 0; page < maxPages; page++ {
		query := fmt.Sprintf(`
query GetEvents {
  getTokenEvents(
    query: {
      address: "%s"
      networkId: %d
      timestamp: {from: %d, to: %d}
      eventType: Swap
    }
    limit: 200
    cursor: %q
  ) {
    items {
      transactionHash
      eventType
      exchangeAddress
    }
    cursor
  }
}`, tok.Address, networkID, fromSec, toSec, cursor)

		body, _ := json.Marshal(map[string]string{"query": query})
		req, err := http.NewRequestWithContext(ctx, "POST", codexURL, bytes.NewReader(body))
		if err != nil {
			return total, len(exchSet), err
		}
		req.Header.Set("Authorization", apiKey)
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			return total, len(exchSet), err
		}
		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return total, len(exchSet), err
		}
		if resp.StatusCode >= 300 {
			return total, len(exchSet), fmt.Errorf("codex http %d: %s", resp.StatusCode, truncate(string(respBody), 200))
		}
		var r codexResp
		if err := json.Unmarshal(respBody, &r); err != nil {
			return total, len(exchSet), fmt.Errorf("codex parse: %w", err)
		}
		if len(r.Errors) > 0 {
			return total, len(exchSet), fmt.Errorf("codex graphql: %s", r.Errors[0].Message)
		}
		for _, it := range r.Data.GetTokenEvents.Items {
			if _, seen := hashSet[it.TransactionHash]; seen {
				continue
			}
			hashSet[it.TransactionHash] = struct{}{}
			total++
			if it.ExchangeAddress != "" {
				exchSet[it.ExchangeAddress] = struct{}{}
			}
		}
		if r.Data.GetTokenEvents.Cursor == "" || len(r.Data.GetTokenEvents.Items) == 0 {
			break
		}
		cursor = r.Data.GetTokenEvents.Cursor
	}
	return total, len(exchSet), nil
}
