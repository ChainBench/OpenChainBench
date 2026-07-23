package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const bitqueryURL = "https://streaming.bitquery.io/graphql"

// bitqueryEVMResp / bitquerySolanaResp keep the response tight: only
// what we need to count trades and derive DEX venues.
type bitqueryEVMResp struct {
	Data struct {
		EVM struct {
			DEXTrades []struct {
				Transaction struct {
					Hash string `json:"Hash"`
				} `json:"Transaction"`
				Trade struct {
					Dex struct {
						ProtocolName string `json:"ProtocolName"`
					} `json:"Dex"`
				} `json:"Trade"`
			} `json:"DEXTrades"`
		} `json:"EVM"`
	} `json:"data"`
}

type bitquerySolanaResp struct {
	Data struct {
		Solana struct {
			DEXTradeByTokens []struct {
				Transaction struct {
					Signature string `json:"Signature"`
				} `json:"Transaction"`
				Trade struct {
					Dex struct {
						ProtocolName string `json:"ProtocolName"`
					} `json:"Dex"`
				} `json:"Trade"`
			} `json:"DEXTradeByTokens"`
		} `json:"Solana"`
	} `json:"data"`
}

// fetchBitquery returns (trade count, distinct DEXs, error). Bitquery
// caps a single query at 10000 rows and has no cursor pagination on
// DEXTradeByTokens; on tokens whose true trade count exceeds 10k the
// bench under-reports Bitquery vs a paginated provider. The findings
// section of the spec calls this out honestly rather than pretending
// Bitquery is worse than it is.
func fetchBitquery(
	ctx context.Context,
	client *http.Client,
	apiKey string,
	tok Token,
	windowStart, windowEnd int64,
	maxRows int,
) (int, int, error) {
	if apiKey == "" {
		return 0, 0, fmt.Errorf("BITQUERY_API_KEY not set")
	}
	if maxRows <= 0 {
		maxRows = 10000
	}

	sinceISO := time.Unix(windowStart/1000, 0).UTC().Format(time.RFC3339)
	tillISO := time.Unix(windowEnd/1000, 0).UTC().Format(time.RFC3339)

	var query string
	if tok.Chain == "solana" {
		query = solanaTradesGQL(tok.Address, sinceISO, tillISO, maxRows)
	} else {
		network := bitqueryEVMNetwork(tok.Chain)
		if network == "" {
			return 0, 0, fmt.Errorf("bitquery: unsupported chain %s", tok.Chain)
		}
		query = evmTradesGQL(network, tok.Address, sinceISO, tillISO, maxRows)
	}

	body, _ := json.Marshal(map[string]string{"query": query})
	req, err := http.NewRequestWithContext(ctx, "POST", bitqueryURL, bytes.NewReader(body))
	if err != nil {
		return 0, 0, err
	}
	// Bitquery's new OAuth-style keys (ory_at_*) require Bearer auth on
	// streaming.bitquery.io/graphql. The legacy X-API-KEY header on that
	// endpoint returns HTTP 402 "No active billing period" even when the
	// account has an active free plan — the migration was silent and the
	// docs still show the old header on some pages.
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	respBody, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		return 0, 0, err
	}
	if resp.StatusCode >= 300 {
		return 0, 0, fmt.Errorf("bitquery http %d: %s", resp.StatusCode, truncate(string(respBody), 200))
	}

	dexSet := map[string]struct{}{}
	hashSet := map[string]struct{}{}

	if tok.Chain == "solana" {
		var r bitquerySolanaResp
		if err := json.Unmarshal(respBody, &r); err != nil {
			return 0, 0, fmt.Errorf("bitquery parse: %w", err)
		}
		for _, t := range r.Data.Solana.DEXTradeByTokens {
			if _, seen := hashSet[t.Transaction.Signature]; seen {
				continue
			}
			hashSet[t.Transaction.Signature] = struct{}{}
			if t.Trade.Dex.ProtocolName != "" {
				dexSet[t.Trade.Dex.ProtocolName] = struct{}{}
			}
		}
	} else {
		var r bitqueryEVMResp
		if err := json.Unmarshal(respBody, &r); err != nil {
			return 0, 0, fmt.Errorf("bitquery parse: %w", err)
		}
		for _, t := range r.Data.EVM.DEXTrades {
			if _, seen := hashSet[t.Transaction.Hash]; seen {
				continue
			}
			hashSet[t.Transaction.Hash] = struct{}{}
			if t.Trade.Dex.ProtocolName != "" {
				dexSet[t.Trade.Dex.ProtocolName] = struct{}{}
			}
		}
	}
	return len(hashSet), len(dexSet), nil
}

func bitqueryEVMNetwork(chain string) string {
	switch chain {
	case "ethereum":
		return "eth"
	case "bsc":
		return "bsc"
	case "base":
		return "base"
	}
	return ""
}

func solanaTradesGQL(mintAddress, since, till string, maxRows int) string {
	return fmt.Sprintf(`{
  Solana(dataset: realtime) {
    DEXTradeByTokens(
      limit: {count: %d}
      where: {
        Block: {Time: {since: "%s", till: "%s"}}
        Trade: {Currency: {MintAddress: {is: "%s"}}}
      }
    ) {
      Transaction { Signature }
      Trade { Dex { ProtocolName } }
    }
  }
}`, maxRows, since, till, mintAddress)
}

func evmTradesGQL(network, tokenAddress, since, till string, maxRows int) string {
	return fmt.Sprintf(`{
  EVM(dataset: realtime, network: %s) {
    DEXTrades(
      limit: {count: %d}
      where: {
        Block: {Time: {since: "%s", till: "%s"}}
        Trade: {Buy: {Currency: {SmartContract: {is: "%s"}}}}
      }
    ) {
      Transaction { Hash }
      Trade { Dex { ProtocolName } }
    }
  }
}`, network, maxRows, since, till, tokenAddress)
}
