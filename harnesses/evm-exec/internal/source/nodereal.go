package source

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// AssetTransfer is one native-asset (BNB/ETH) transfer from NodeReal nr_getAssetTransfers.
type AssetTransfer struct {
	TxHash   string
	BlockNum uint64
	Amount   *big.Int // wei, never divided
	EventKey string   // position index within (tx_hash) group for uniqueness
}

type nrTransfer struct {
	BlockNum string `json:"blockNum"`
	Hash     string `json:"hash"`
	Value    string `json:"value"`
	Category string `json:"category"`
}

// GetNativeTransfers fetches all native asset (BNB) transfers to toAddress in [fromBlock, toBlock]
// using NodeReal nr_getAssetTransfers with full pagination via pageKey.
func GetNativeTransfers(ctx context.Context, rpcURL, toAddress string, fromBlock, toBlock uint64) ([]AssetTransfer, error) {
	var allRaw []nrTransfer
	pageKey := ""

	for {
		params := map[string]any{
			"fromBlock":        fmt.Sprintf("0x%x", fromBlock),
			"toBlock":          fmt.Sprintf("0x%x", toBlock),
			"toAddress":        toAddress,
			"category":         []string{"external", "internal"},
			"withMetadata":     true,
			"excludeZeroValue": true,
			"maxCount":         "0x3e8", // 1000
		}
		if pageKey != "" {
			params["pageKey"] = pageKey
		}

		body, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"method":  "nr_getAssetTransfers",
			"params":  []any{params},
		})

		var out struct {
			Result *struct {
				Transfers []nrTransfer `json:"transfers"`
				PageKey   string       `json:"pageKey"`
			} `json:"result"`
			Error *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}

		var lastErr error
		for attempt := range 3 {
			if attempt > 0 {
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(time.Duration(attempt*attempt) * time.Second):
				}
			}
			if err := RpcPost(ctx, rpcURL, body, &out); err != nil {
				lastErr = err
				continue
			}
			lastErr = nil
			break
		}
		if lastErr != nil {
			return nil, fmt.Errorf("nr_getAssetTransfers: %w", lastErr)
		}
		if out.Error != nil {
			return nil, fmt.Errorf("nr_getAssetTransfers RPC %d: %s", out.Error.Code, out.Error.Message)
		}
		if out.Result == nil {
			return nil, fmt.Errorf("nr_getAssetTransfers: null result")
		}

		allRaw = append(allRaw, out.Result.Transfers...)
		pageKey = out.Result.PageKey
		if pageKey == "" {
			break
		}
	}

	// Assign event_key as position within each tx_hash group (handles multicall).
	txCount := make(map[string]int, len(allRaw))
	result := make([]AssetTransfer, 0, len(allRaw))

	for _, t := range allRaw {
		if t.Value == "" || t.Value == "0x0" {
			continue
		}
		amt, err := ParseHexAmount(t.Value)
		if err != nil || amt.Sign() <= 0 {
			continue
		}
		blockNum, err := ParseHex64(t.BlockNum)
		if err != nil {
			continue
		}
		hash := strings.ToLower(t.Hash)
		idx := txCount[hash]
		txCount[hash]++

		result = append(result, AssetTransfer{
			TxHash:   hash,
			BlockNum: blockNum,
			Amount:   amt,
			EventKey: fmt.Sprintf("%d", idx),
		})
	}
	return result, nil
}
