package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Litecoin native-transfer fee sampler (UTXO).
//
// Litecoin uses a mempool fee market just like Bitcoin. We hit the
// litecoinspace.org mempool oracle (same vendor we already use in the L1
// finality harness) at /api/v1/fees/recommended which returns
// litoshis/vByte for 5 named tiers: fastestFee, halfHourFee, hourFee,
// economyFee, minimumFee.
//
// A standard single-input / single-output P2WPKH native LTC transfer is
// ~225 vBytes. For each tier:
//
//	fee_litoshis = lit_per_vbyte * 225
//
// We emit only the three tiers we care about for cross-chain comparison:
//
//	slow = hourFee     * 225
//	std  = halfHourFee * 225
//	fast = fastestFee  * 225
//
// Values are in litoshis (1 LTC = 10^8 litoshis). main.go's nativeToUSD()
// divides by 10^8 for KindUTXO. During low congestion all five fields are
// often 1 lit/vByte — 225 litoshis ≈ $0.0001, which is fine to emit.

const ltcNativeTransferVBytes = 225.0

type litecoinFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindUTXO, &litecoinFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

type ltcFeesResp struct {
	FastestFee  float64 `json:"fastestFee"`
	HalfHourFee float64 `json:"halfHourFee"`
	HourFee     float64 `json:"hourFee"`
	EconomyFee  float64 `json:"economyFee"`
	MinimumFee  float64 `json:"minimumFee"`
}

func (f *litecoinFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	url := ch.RPCURL + "/v1/fees/recommended"
	resp, err := f.http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:min(len(raw), 200)])) //nolint:gomnd
	}
	var r ltcFeesResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	tiers := []struct {
		name      string
		litPerVB  float64
	}{
		{"slow", r.HourFee},
		{"std", r.HalfHourFee},
		{"fast", r.FastestFee},
	}
	out := make([]FeeSample, 0, 3)
	for _, t := range tiers {
		out = append(out, FeeSample{
			Chain:     ch.Slug,
			Tier:      t.name,
			NativeFee: t.litPerVB * ltcNativeTransferVBytes,
			GasPrice:  t.litPerVB, // surface lit/vByte for parity with EVM gwei field
		})
	}
	return out, nil
}
