package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"time"
)

// Sui: a canonical coin module publish costs ~5-15M MIST gas units
// depending on module size. For the headline number we use the live
// reference gas price (`suix_getReferenceGasPrice`, 100 MIST as of 2026)
// × a fixed reference budget. A future improvement is to dryRun an actual
// publish tx with the canonical coin module bytecode pinned in the repo.
//
// Aptos: similar — /v1/estimate_gas_price gives `gas_estimate` in octas,
// canonical FA publish + create_primary_store + mint fits ~20k-30k gas
// units. Using a fixed reference budget for now.

const (
	// Sui: canonical Coin module publish + Display + TreasuryCap typically
	// consumes 3-5M effective gas units net of storage rebate on mainnet.
	// 5M is the realistic mid-point — using the 8M ceiling overstates by
	// roughly 60%.
	suiReferenceGasBudget uint64 = 5_000_000
	// Aptos: FA standard publish (`fungible_asset::create_primary_store_
	// enabled_fungible_asset` + metadata + initial mint) burns ~150k gas
	// units on mainnet. The original 25k figure was a transfer-class
	// estimate, way too low for a publish.
	aptosReferenceGasBudget uint64 = 150_000
)

type suiSampler struct {
	http *http.Client
}

type aptosSampler struct {
	http *http.Client
}

func init() {
	registerSampler(KindSui, &suiSampler{http: &http.Client{Timeout: 8 * time.Second}})
	registerSampler(KindAptos, &aptosSampler{http: &http.Client{Timeout: 8 * time.Second}})
}

// ----- Sui ---------------------------------------------------------------

type suiRPCReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type suiRPCResp struct {
	Result string `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (s *suiSampler) Sample(ch ChainConfig) (Sample, error) {
	body, _ := json.Marshal(suiRPCReq{
		JSONRPC: "2.0", ID: 1,
		Method: "suix_getReferenceGasPrice",
		Params: []any{},
	})
	req, err := http.NewRequest("POST", ch.RPCURL, bytesNewReader(body))
	if err != nil {
		return Sample{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.http.Do(req)
	if err != nil {
		return Sample{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return Sample{}, err
	}
	var r suiRPCResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return Sample{}, fmt.Errorf("decode: %w (body=%s)", err, string(raw))
	}
	if r.Error != nil {
		return Sample{}, fmt.Errorf("rpc error %d: %s", r.Error.Code, r.Error.Message)
	}
	gp, err := strconv.ParseUint(r.Result, 10, 64)
	if err != nil {
		return Sample{}, fmt.Errorf("parse gas price %q: %w", r.Result, err)
	}
	total := gp * suiReferenceGasBudget
	return Sample{
		CostNative: float64(total),
		NativeUnit: "mist",
		GasUnits:   float64(suiReferenceGasBudget),
	}, nil
}

// ----- Aptos -------------------------------------------------------------

type aptosEstimate struct {
	GasEstimate                uint64 `json:"gas_estimate"`
	DeprioritizedGasEstimate   uint64 `json:"deprioritized_gas_estimate"`
	PrioritizedGasEstimate     uint64 `json:"prioritized_gas_estimate"`
}

func (s *aptosSampler) Sample(ch ChainConfig) (Sample, error) {
	resp, err := s.http.Get(ch.RPCURL + "/v1/estimate_gas_price")
	if err != nil {
		return Sample{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return Sample{}, err
	}
	var est aptosEstimate
	if err := json.Unmarshal(raw, &est); err != nil {
		return Sample{}, fmt.Errorf("decode: %w (body=%s)", err, string(raw))
	}
	total := est.GasEstimate * aptosReferenceGasBudget
	return Sample{
		CostNative: float64(total),
		NativeUnit: "octa",
		GasUnits:   float64(aptosReferenceGasBudget),
	}, nil
}

var _ = math.NaN
