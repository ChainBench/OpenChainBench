package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// Precomputed keccak256("fn()")[:4] selectors — verified with `cast sig`.
const (
	selLastSettlementTs      = "0x5ae45c26" // lastSettlementTs()
	selMaxSettlementInterval = "0xc996a956" // maxSettlementInterval()
	selLastSettlementId      = "0x39598fae" // lastSettlementId()
	selCurrentEpoch          = "0x76671808" // currentEpoch()
	selCurrentEpochStart     = "0x61a8c8c4" // currentEpochStart()
)

var httpClient = &http.Client{Timeout: 10 * time.Second}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResponse struct {
	Result string `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func ethCall(rpcURL, contract, selector string) (*big.Int, error) {
	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "eth_call",
		Params: []any{
			map[string]string{"to": contract, "data": selector},
			"latest",
		},
	}
	body, _ := json.Marshal(req)
	resp, err := httpClient.Post(rpcURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	var out rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if out.Error != nil {
		return nil, fmt.Errorf("rpc: %s", out.Error.Message)
	}
	hex := strings.TrimPrefix(out.Result, "0x")
	if hex == "" {
		return nil, fmt.Errorf("empty result for %s on %s", selector, contract)
	}
	n := new(big.Int)
	n.SetString(hex, 16)
	return n, nil
}
