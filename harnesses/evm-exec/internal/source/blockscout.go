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

// Blockscout Etherscan-compatible API for chains that have a Blockscout explorer
// but are not supported by Etherscan V2.
const (
	BlockscoutRobinhood = "https://robinhoodchain.blockscout.com/api"
)

// blockscoutTx matches the Blockscout txlistinternal result shape.
type blockscoutTx struct {
	TransactionHash string `json:"transactionHash"`
	BlockNumber     string `json:"blockNumber"`
	TimeStamp       string `json:"timeStamp"`
	Value           string `json:"value"`
	To              string `json:"to"`
	IsError         string `json:"isError"`
	Index           string `json:"index"` // trace position within the tx (event key)
}

// GetBlockscoutInternalTxs fetches internal ETH transfers to address via Blockscout.
// apiURL is the chain-specific Blockscout API base (e.g. blockscoutRobinhood).
func GetBlockscoutInternalTxs(ctx context.Context, apiURL, address string, startBlock uint64) ([]NativeTx, uint64, error) {
	const offset = 1000
	const maxPage = 20 // 20k results max before we advance the window

	addrLower := strings.ToLower(address)
	var all []NativeTx
	highestBlock := startBlock
	curStart := startBlock

	for {
		var windowTxs []NativeTx
		hitCap := false

		for page := 1; page <= maxPage; page++ {
			time.Sleep(300 * time.Millisecond)

			params := url.Values{
				"module":     {"account"},
				"action":     {"txlistinternal"},
				"address":    {address},
				"startblock": {fmt.Sprintf("%d", curStart)},
				"endblock":   {"99999999"},
				"page":       {fmt.Sprintf("%d", page)},
				"offset":     {fmt.Sprintf("%d", offset)},
				"sort":       {"asc"},
			}

			req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL+"?"+params.Encode(), nil)
			if err != nil {
				return all, highestBlock, err
			}
			resp, err := httpClient.Do(req)
			if err != nil {
				return all, highestBlock, fmt.Errorf("blockscout page %d: %w", page, err)
			}

			var out struct {
				Status  string            `json:"status"`
				Message string            `json:"message"`
				Result  json.RawMessage   `json:"result"`
			}
			decErr := json.NewDecoder(resp.Body).Decode(&out)
			resp.Body.Close()
			if decErr != nil {
				return all, highestBlock, fmt.Errorf("blockscout decode: %w", decErr)
			}

			// Blockscout status "0" = error/empty, "1" = full results, "2" = partial (still valid).
			if out.Status == "0" {
				break
			}
			if out.Status != "1" && out.Status != "2" {
				var msg string
				json.Unmarshal(out.Result, &msg) //nolint:errcheck
				return all, highestBlock, fmt.Errorf("blockscout: %s %s", out.Message, msg)
			}

			var txs []blockscoutTx
			if err := json.Unmarshal(out.Result, &txs); err != nil {
				break
			}

			for _, tx := range txs {
				if tx.IsError == "1" || tx.Value == "" || tx.Value == "0" {
					continue
				}
				if strings.ToLower(tx.To) != addrLower {
					continue
				}
				amt, err := new(big.Int).SetString(tx.Value, 10)
				if !err || amt.Sign() <= 0 {
					continue
				}
				blockNum, parseErr := parseDecU64(tx.BlockNumber)
				if parseErr != nil {
					continue
				}
				var bt time.Time
				if ts, tsErr := parseDecU64(tx.TimeStamp); tsErr == nil && ts > 0 {
					bt = time.Unix(int64(ts), 0).UTC()
				}
				ntx := NativeTx{
					TxHash:    strings.ToLower(tx.TransactionHash),
					BlockNum:  blockNum,
					BlockTime: bt,
					Amount:    amt,
					EventKey:  tx.Index,
				}
				windowTxs = append(windowTxs, ntx)
				if blockNum > highestBlock {
					highestBlock = blockNum
				}
			}

			if len(txs) < offset {
				break
			}
			if page == maxPage {
				hitCap = true
				break
			}
		}

		all = append(all, windowTxs...)

		if !hitCap || len(windowTxs) == 0 {
			break
		}

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
