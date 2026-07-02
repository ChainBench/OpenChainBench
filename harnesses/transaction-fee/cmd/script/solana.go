package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"
)

// Solana native-transfer fee sampler.
//
// Solana's fee model has two parts:
//   1. Base fee: 5000 lamports per signature, flat, always paid.
//   2. Priority fee: variable, paid in micro-lamports per Compute Unit (CU),
//      consumed only when the tx sets a ComputeBudget priority instruction.
//
// We pull recent priority fees via getRecentPrioritizationFees (returns up
// to ~150 samples from the last 150 slots). A standard system-program SOL
// transfer burns ~200 CU, so the priority cost in lamports is:
//
//   priority_lamports = (microlamports_per_cu * 200) / 1_000_000
//
// Total fee per tier:
//
//   fee_lamports[tier] = 5000 + priority_lamports[ p25 | p50 | p90 ]
//
// We drop zero-fee samples before percentile bucketing — idle slots are
// extremely common on Solana and would flatten every tier to the 5000
// base. If every sample is zero or the array is empty, we emit a single
// "std" tier with just the 5000 base.

const (
	solBaseFeeLamports = 5000.0
	solTransferCU      = 200.0
)

type solanaFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindSolana, &solanaFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

type solPriorityFeeResp struct {
	JSONRPC string `json:"jsonrpc"`
	Result  []struct {
		Slot              uint64  `json:"slot"`
		PrioritizationFee float64 `json:"prioritizationFee"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
	ID int `json:"id"`
}

func (f *solanaFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	body, _ := json.Marshal(jsonRPCReq{
		JSONRPC: "2.0",
		Method:  "getRecentPrioritizationFees",
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
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:min(len(raw), 200)])) //nolint:gomnd
	}
	var r solPriorityFeeResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc error: %s", r.Error.Message)
	}

	// Collect non-zero priority fee samples (microlamports per CU).
	fees := make([]float64, 0, len(r.Result))
	for _, s := range r.Result {
		if s.PrioritizationFee > 0 {
			fees = append(fees, s.PrioritizationFee)
		}
	}

	if len(fees) == 0 {
		// Idle network or empty response: emit single std tier with just base fee.
		return []FeeSample{{
			Chain:     ch.Slug,
			Tier:      "std",
			NativeFee: solBaseFeeLamports,
		}}, nil
	}

	sort.Float64s(fees)

	tiers := []struct {
		name string
		pct  float64
	}{
		{"slow", 0.25},
		{"std", 0.50},
		{"fast", 0.90},
	}

	out := make([]FeeSample, 0, 3)
	for _, t := range tiers {
		microLamportsPerCU := percentile(fees, t.pct)
		priorityLamports := (microLamportsPerCU * solTransferCU) / 1_000_000.0
		out = append(out, FeeSample{
			Chain:     ch.Slug,
			Tier:      t.name,
			NativeFee: solBaseFeeLamports + priorityLamports,
		})
	}
	return out, nil
}

// percentile returns the value at percentile p (0..1) of a pre-sorted slice
// using nearest-rank. Caller guarantees len(sorted) > 0.
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 1 {
		return sorted[0]
	}
	idx := int(p * float64(len(sorted)-1))
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}
