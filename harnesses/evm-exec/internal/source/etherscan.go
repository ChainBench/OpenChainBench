package source

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	etherscanV2     = "https://api.etherscan.io/v2/api"
	ChainIDEthereum = "1"
	ChainIDBase     = "8453" // Base via Etherscan V2 (same key as Ethereum, no separate BaseScan key)
)

// NativeTx is an ETH transfer (internal or normal) to a monitored address.
type NativeTx struct {
	TxHash    string
	BlockNum  uint64
	BlockTime time.Time // from Etherscan timeStamp, avoids eth_getBlockByNumber
	Amount    *big.Int  // wei, never divided
	EventKey  string    // traceId for internal txs, "" for normal value txs
}

type etherscanTx struct {
	Hash        string `json:"hash"`
	BlockNumber string `json:"blockNumber"`
	TimeStamp   string `json:"timeStamp"` // unix seconds as decimal string
	Value       string `json:"value"`
	To          string `json:"to"`
	IsError     string `json:"isError"`
	TraceID     string `json:"traceId"`
}

// GetEtherscanInternalTxs fetches ETH internal transfers to address starting from startBlock.
func GetEtherscanInternalTxs(ctx context.Context, apiKey, chainID, address string, startBlock uint64) ([]NativeTx, uint64, error) {
	return fetchEtherscanTxs(ctx, apiKey, chainID, address, startBlock, "txlistinternal", func(tx etherscanTx) (NativeTx, bool) {
		if tx.IsError == "1" || tx.Value == "0" || tx.Value == "" {
			return NativeTx{}, false
		}
		amt, err := ParseDecAmount(tx.Value)
		if err != nil || amt.Sign() <= 0 {
			return NativeTx{}, false
		}
		blockNum, err := parseDecU64(tx.BlockNumber)
		if err != nil {
			return NativeTx{}, false
		}
		var bt time.Time
		if ts, err2 := parseDecU64(tx.TimeStamp); err2 == nil && ts > 0 {
			bt = time.Unix(int64(ts), 0).UTC()
		}
		return NativeTx{TxHash: strings.ToLower(tx.Hash), BlockNum: blockNum, BlockTime: bt, Amount: amt, EventKey: tx.TraceID}, true
	})
}

// GetEtherscanNormalTxs fetches plain ETH value transfers to address starting from startBlock.
func GetEtherscanNormalTxs(ctx context.Context, apiKey, chainID, address string, startBlock uint64) ([]NativeTx, uint64, error) {
	addrLower := strings.ToLower(address)
	return fetchEtherscanTxs(ctx, apiKey, chainID, address, startBlock, "txlist", func(tx etherscanTx) (NativeTx, bool) {
		if tx.IsError == "1" || tx.Value == "0" || tx.Value == "" {
			return NativeTx{}, false
		}
		if strings.ToLower(tx.To) != addrLower {
			return NativeTx{}, false
		}
		amt, err := ParseDecAmount(tx.Value)
		if err != nil || amt.Sign() <= 0 {
			return NativeTx{}, false
		}
		blockNum, err := parseDecU64(tx.BlockNumber)
		if err != nil {
			return NativeTx{}, false
		}
		var bt time.Time
		if ts, err2 := parseDecU64(tx.TimeStamp); err2 == nil && ts > 0 {
			bt = time.Unix(int64(ts), 0).UTC()
		}
		return NativeTx{TxHash: strings.ToLower(tx.Hash), BlockNum: blockNum, BlockTime: bt, Amount: amt, EventKey: ""}, true
	})
}

type filterFn func(etherscanTx) (NativeTx, bool)

// fetchEtherscanTxs handles Etherscan pagination including the 10k-result cap.
func fetchEtherscanTxs(ctx context.Context, apiKey, chainID, address string, startBlock uint64, action string, filter filterFn) ([]NativeTx, uint64, error) {
	const (
		offset   = 1000
		maxPage  = 10
		endBlock = 99999999
	)

	var all []NativeTx
	highestBlock := startBlock
	curStart := startBlock

	for {
		var windowTxs []NativeTx
		hitCap := false
		page := 1

		for page <= maxPage {
			time.Sleep(250 * time.Millisecond)

			batch, err := etherscanPage(ctx, apiKey, chainID, address, action, curStart, endBlock, page, offset)
			if err != nil {
				return all, highestBlock, fmt.Errorf("etherscan %s page %d: %w", action, page, err)
			}

			for _, tx := range batch {
				if ntx, ok := filter(tx); ok {
					windowTxs = append(windowTxs, ntx)
					if ntx.BlockNum > highestBlock {
						highestBlock = ntx.BlockNum
					}
				}
			}

			if len(batch) < offset {
				break // last page
			}
			if page == maxPage {
				hitCap = true
				break
			}
			page++
		}

		all = append(all, windowTxs...)

		if !hitCap || len(windowTxs) == 0 {
			break
		}

		// Advance past what we've seen and loop.
		var lastBlock uint64
		for _, tx := range windowTxs {
			if tx.BlockNum > lastBlock {
				lastBlock = tx.BlockNum
			}
		}
		if lastBlock <= curStart {
			break
		}
		curStart = lastBlock
	}

	return all, highestBlock, nil
}

func etherscanPage(ctx context.Context, apiKey, chainID, address, action string, startBlock uint64, endBlock, page, offset int) ([]etherscanTx, error) {
	apiURL := etherscanV2
	params := url.Values{
		"module":     {"account"},
		"action":     {action},
		"address":    {address},
		"startblock": {fmt.Sprintf("%d", startBlock)},
		"endblock":   {fmt.Sprintf("%d", endBlock)},
		"page":       {fmt.Sprintf("%d", page)},
		"offset":     {fmt.Sprintf("%d", offset)},
		"sort":       {"asc"},
		"apikey":     {apiKey},
	}
	if chainID != "" {
		params.Set("chainid", chainID)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out struct {
		Status  string          `json:"status"`
		Message string          `json:"message"`
		Result  json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("etherscan decode: %w", err)
	}
	if out.Status == "0" && strings.Contains(out.Message, "No transactions") {
		return nil, nil
	}
	if out.Status != "1" {
		var msg string
		json.Unmarshal(out.Result, &msg) //nolint:errcheck
		return nil, fmt.Errorf("etherscan %s: %s %s", action, out.Message, msg)
	}

	var txs []etherscanTx
	if err := json.Unmarshal(out.Result, &txs); err != nil {
		return nil, fmt.Errorf("etherscan result decode: %w", err)
	}
	return txs, nil
}

func parseDecU64(s string) (uint64, error) {
	var n uint64
	_, err := fmt.Sscan(s, &n)
	return n, err
}
