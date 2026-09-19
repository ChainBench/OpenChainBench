package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// TRON native-transfer fee sampler.
//
// TRON uses a bandwidth/energy model. A native TRX transfer consumes
// bandwidth only (no energy — energy is for smart contracts). A typical
// TRX transfer is ~268 bytes. Each byte costs `getTransactionFee` SUN
// from chain params (currently 1000 SUN/byte = 0.001 TRX/byte).
//
// Free bandwidth allowance is 600 bytes/day/account, but we model the
// "paid" case (no free bandwidth) since that's the worst-case observable
// cost. Result: ~268_000 SUN (0.268 TRX) at 1000 SUN/byte.
//
// We query https://api.trongrid.io/wallet/getchainparameters to fetch
// the live `getTransactionFee` value. Single tier "single" — TRON has
// no priority market for native transfers.

const tronTransferBytes = 268

type tronFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindTron, &tronFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

type tronChainParam struct {
	Key   string `json:"key"`
	Value int64  `json:"value"`
}

type tronChainParamsResp struct {
	ChainParameter []tronChainParam `json:"chainParameter"`
}

func (f *tronFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	url := ch.RPCURL + "/wallet/getchainparameters"
	resp, err := f.http.Post(url, "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:min(len(raw), 200)]))
	}
	var r tronChainParamsResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("decode chainparameters: %w", err)
	}
	var sunPerByte int64
	for _, p := range r.ChainParameter {
		if p.Key == "getTransactionFee" {
			sunPerByte = p.Value
			break
		}
	}
	if sunPerByte <= 0 {
		return nil, fmt.Errorf("getTransactionFee not found in chain params")
	}
	feeSun := float64(sunPerByte * tronTransferBytes)
	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "single",
		NativeFee: feeSun,
	}}, nil
}
