package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// SUI native-transfer fee sampler.
//
// Calls JSON-RPC `suix_getReferenceGasPrice` against the mainnet fullnode
// to fetch the current reference gas price (MIST per gas unit). Multiplies
// by a hardcoded typical gas budget for a basic SUI Coin::transfer.
//
// Gas budget choice: a Coin::transfer entry function consumes ~76_000
// computation + storage units in mainnet conditions (verified via
// `sui_dryRunTransactionBlock` on a known transfer). The initial value of
// 2_000_000 was the on-chain *budget* (max gas the wallet authorises) not
// the *actual cost* — that mismatch produced fees ~25x higher than what
// users actually pay.
//
// An accurate live estimate would require `sui_dryRunTransactionBlock`
// with a real signed-ish transaction payload, which is too heavy for a
// 30s scrape. 76_000 is the typical observed cost for a basic transfer
// and aligns with SUI explorer (e.g. suivision.xyz) — about $0.001 at
// current SUI prices.
//
// Emits a single "std" tier — SUI gas pricing is effectively flat at the
// reference price (validators rarely deviate).

const suiTransferGasBudget = 76_000

type suiFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindSui, &suiFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

type suiRPCResp struct {
	JSONRPC string `json:"jsonrpc"`
	Result  string `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (f *suiFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	body, _ := json.Marshal(jsonRPCReq{
		JSONRPC: "2.0",
		Method:  "suix_getReferenceGasPrice",
		Params:  []any{},
		ID:      1,
	})
	resp, err := f.http.Post(ch.RPCURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:min(len(raw), 200)]))
	}
	var r suiRPCResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("decode sui rpc: %w", err)
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc error: %s", r.Error.Message)
	}
	gasPrice, err := strconv.ParseInt(r.Result, 10, 64)
	if err != nil || gasPrice <= 0 {
		return nil, fmt.Errorf("bad reference gas price: %q", r.Result)
	}
	feeMist := float64(gasPrice * suiTransferGasBudget)
	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "std",
		NativeFee: feeMist,
		GasPrice:  float64(gasPrice),
	}}, nil
}
