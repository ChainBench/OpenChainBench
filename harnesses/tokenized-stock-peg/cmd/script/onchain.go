package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// Onchain leg: one JSON-RPC batch per tick, one eth_call per asset to
// StateView.getSlot0(poolId) on the Uniswap v4 singleton's view
// contract. The response's first 32-byte word is sqrtPriceX96.
//
// Price math (v4 = v3 semantics): raw = (sqrtPriceX96 / 2^96)^2 is the
// amount of currency1 base units per 1 base unit of currency0. With
// USDG at 6 decimals and stocks at 18:
//   USDG is currency0 → USDG per stock = 1e12 / raw
//   USDG is currency1 → USDG per stock = raw × 1e12
// (verified against the live AAPL pool: 319.42 USDG on 2026-07-13).

type batchReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type batchResp struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

var q96 = new(big.Float).SetPrec(200).SetInt(new(big.Int).Lsh(big.NewInt(1), 96))

func fetchOnchainPrices(client *http.Client) map[string]float64 {
	reqs := make([]batchReq, 0, len(assets))
	for i, a := range assets {
		data := getSlot0Sel + strings.TrimPrefix(strings.ToLower(a.PoolID), "0x")
		reqs = append(reqs, batchReq{
			JSONRPC: "2.0", ID: i, Method: "eth_call",
			Params: []any{map[string]string{"to": stateView, "data": data}, "latest"},
		})
	}
	body, _ := json.Marshal(reqs)
	req, err := http.NewRequest("POST", rpcURL(), bytes.NewReader(body))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		tspSourceCall.WithLabelValues("onchain", "network").Inc()
		return nil
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<22))
	if err != nil || resp.StatusCode != 200 {
		tspSourceCall.WithLabelValues("onchain", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return nil
	}
	tspSourceLatency.WithLabelValues("onchain").Set(float64(time.Since(start).Milliseconds()))

	var out []batchResp
	if err := json.Unmarshal(raw, &out); err != nil {
		tspSourceCall.WithLabelValues("onchain", "parse").Inc()
		return nil
	}
	prices := make(map[string]float64, len(assets))
	for _, r := range out {
		if r.ID < 0 || r.ID >= len(assets) {
			continue
		}
		a := assets[r.ID]
		sym := strings.ToLower(a.Symbol)
		if r.Error != nil {
			// Issuer pause/block or pool state error: skip the sample so
			// Prom staleness ages the series out instead of freezing it.
			tspSourceCall.WithLabelValues("onchain", "rpc_error").Inc()
			fmt.Printf("[%s] onchain error: %s\n", sym, r.Error.Message)
			continue
		}
		p, ok := slot0ToUSDG(string(r.Result), a.USDGIsC0)
		if !ok || p <= 0 {
			tspSourceCall.WithLabelValues("onchain", "decode").Inc()
			continue
		}
		prices[sym] = p
		tspSourceCall.WithLabelValues("onchain", "ok").Inc()
	}
	return prices
}

// slot0ToUSDG parses the getSlot0 return blob (sqrtPriceX96 is the
// first word) and converts to USDG per stock respecting pool ordering.
func slot0ToUSDG(resultJSON string, usdgIsC0 bool) (float64, bool) {
	hexStr := strings.Trim(resultJSON, `"`)
	hexStr = strings.TrimPrefix(hexStr, "0x")
	if len(hexStr) < 64 {
		return 0, false
	}
	sqrtInt, ok := new(big.Int).SetString(hexStr[:64], 16)
	if !ok || sqrtInt.Sign() == 0 {
		return 0, false
	}
	sqrtF := new(big.Float).SetPrec(200).SetInt(sqrtInt)
	ratio := new(big.Float).SetPrec(200).Quo(sqrtF, q96)
	raw := new(big.Float).SetPrec(200).Mul(ratio, ratio)

	e12 := new(big.Float).SetPrec(200).SetFloat64(1e12)
	var price *big.Float
	if usdgIsC0 {
		price = new(big.Float).SetPrec(200).Quo(e12, raw)
	} else {
		price = new(big.Float).SetPrec(200).Mul(raw, e12)
	}
	f, _ := price.Float64()
	return f, true
}
