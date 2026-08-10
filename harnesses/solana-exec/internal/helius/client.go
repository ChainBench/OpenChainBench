package helius

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Client wraps the Helius RPC + enhanced-transactions APIs.
type Client struct {
	httpClient *http.Client
	apiKey     string
	rpcURL     string // https://mainnet.helius-rpc.com/?api-key=KEY
	enhURL     string // https://api.helius.xyz/v0/transactions?api-key=KEY
}

func New(apiKey string) *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		apiKey:     apiKey,
		rpcURL:     fmt.Sprintf("https://mainnet.helius-rpc.com/?api-key=%s", apiKey),
		enhURL:     fmt.Sprintf("https://api.helius.xyz/v0/transactions?api-key=%s", apiKey),
	}
}

// SigEntry is one result from getSignaturesForAddress.
type SigEntry struct {
	Signature string `json:"signature"`
	Slot      uint64 `json:"slot"`
	BlockTime int64  `json:"blockTime"` // unix seconds, may be 0
	Err       any    `json:"err"`       // nil = success
}

// GetSignaturesForAddress fetches up to `limit` finalized signatures for
// `address`, newest-first. `until` is the exclusive upper bound (cursor);
// `before` is the exclusive lower bound used for pagination (pass "" for
// the first page).
func (c *Client) GetSignaturesForAddress(ctx context.Context, address string, limit int, until, before string) ([]SigEntry, error) {
	params := map[string]any{
		"limit":      limit,
		"commitment": "finalized",
	}
	if until != "" {
		params["until"] = until
	}
	if before != "" {
		params["before"] = before
	}

	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "getSignaturesForAddress",
		"params":  []any{address, params},
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.rpcURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("helius RPC HTTP %d", resp.StatusCode)
	}

	var out struct {
		Result []SigEntry `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("helius RPC decode: %w", err)
	}
	if out.Error != nil {
		return nil, fmt.Errorf("helius RPC error %d: %s", out.Error.Code, out.Error.Message)
	}
	return out.Result, nil
}

// NativeTransfer is a SOL transfer extracted by Helius.
type NativeTransfer struct {
	FromUserAccount string `json:"fromUserAccount"`
	ToUserAccount   string `json:"toUserAccount"`
	Amount          int64  `json:"amount"` // lamports
}

// EnhancedTx is the Helius-parsed transaction.
type EnhancedTx struct {
	Signature            string           `json:"signature"`
	Slot                 uint64           `json:"slot"`
	Timestamp            int64            `json:"timestamp"` // unix seconds
	Fee                  int64            `json:"fee"`       // total fee lamports
	FeePayer             string           `json:"feePayer"`
	NativeTransfers      []NativeTransfer `json:"nativeTransfers"`
	TransactionError     any              `json:"transactionError"`
	ComputeUnitsConsumed int64            `json:"computeUnitsConsumed"`
}

// GetEnhancedTransactions fetches enhanced parsed transactions for up to 100
// signatures in a single request. Helius caps the batch at 100.
func (c *Client) GetEnhancedTransactions(ctx context.Context, sigs []string) ([]EnhancedTx, error) {
	if len(sigs) == 0 {
		return nil, nil
	}
	if len(sigs) > 100 {
		return nil, fmt.Errorf("helius: enhanced batch max 100 sigs, got %d", len(sigs))
	}

	body, _ := json.Marshal(map[string]any{
		"transactions": sigs,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.enhURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("helius enhanced HTTP %d", resp.StatusCode)
	}

	var txs []EnhancedTx
	if err := json.NewDecoder(resp.Body).Decode(&txs); err != nil {
		return nil, fmt.Errorf("helius enhanced decode: %w", err)
	}
	return txs, nil
}
