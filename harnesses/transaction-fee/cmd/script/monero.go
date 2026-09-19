package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Monero native-transfer fee sampler.
//
// Monero exposes a JSON-RPC method `get_fee_estimate` on monerod that
// returns the network's current per-byte fee in atomic units (piconero,
// 1 XMR = 10^12). Modern nodes return a `fees` array with 4 entries
// representing tiered fee levels [slow, std, fast, fastest]. We map:
//
//	slow = fees[0] * 1500
//	std  = fees[1] * 1500
//	fast = fees[2] * 1500
//
// 1500 bytes is the rough size of a 1-input / 2-output ringct transaction
// (the dominant native-transfer shape on Monero today).
//
// Fallback: if the `fees` array is missing or has fewer than 3 entries we
// emit a single "std" tier using the scalar `fee` field × 1500.
//
// main.go divides by 10^12 (KindMonero) to convert atomic units → XMR.

const xmrNativeTransferBytes = 1500.0

type moneroFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindMonero, &moneroFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

type xmrFeeEstReq struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      string         `json:"id"`
	Method  string         `json:"method"`
	Params  map[string]any `json:"params"`
}

type xmrFeeEstResp struct {
	JSONRPC string `json:"jsonrpc"`
	ID      string `json:"id"`
	Result  struct {
		Fee              float64   `json:"fee"`
		Fees             []float64 `json:"fees"`
		QuantizationMask float64   `json:"quantization_mask"`
		Status           string    `json:"status"`
		Untrusted        bool      `json:"untrusted"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (f *moneroFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	url := ch.RPCURL + "/json_rpc"
	body, _ := json.Marshal(xmrFeeEstReq{
		JSONRPC: "2.0",
		ID:      "0",
		Method:  "get_fee_estimate",
		Params:  map[string]any{},
	})
	resp, err := f.http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:min(len(raw), 200)])) //nolint:gomnd
	}
	var r xmrFeeEstResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc error: %s", r.Error.Message)
	}
	if r.Result.Status != "" && r.Result.Status != "OK" {
		return nil, fmt.Errorf("monero rpc status: %s", r.Result.Status)
	}

	// Preferred path: tiered fees array.
	if len(r.Result.Fees) >= 3 {
		tiers := []string{"slow", "std", "fast"}
		out := make([]FeeSample, 0, 3)
		for i, name := range tiers {
			perByte := r.Result.Fees[i]
			out = append(out, FeeSample{
				Chain:     ch.Slug,
				Tier:      name,
				NativeFee: perByte * xmrNativeTransferBytes,
				GasPrice:  perByte, // atomic units per byte
			})
		}
		return out, nil
	}

	// Fallback: scalar `fee` only.
	if r.Result.Fee <= 0 {
		return nil, fmt.Errorf("monero: no fee data (fees=%v fee=%v)", r.Result.Fees, r.Result.Fee)
	}
	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "std",
		NativeFee: r.Result.Fee * xmrNativeTransferBytes,
		GasPrice:  r.Result.Fee,
	}}, nil
}
