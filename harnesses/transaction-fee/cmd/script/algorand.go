package main

import (
	"fmt"
	"net/http"
	"time"
)

// Algorand native-transfer fee sampler.
//
// Algorand prices a payment transaction as:
//
//   fee_microalgo = max(min_fee, fee_per_byte * tx_size_bytes)
//
// min_fee is a consensus parameter (1000 microAlgo = 0.001 ALGO since
// genesis). fee_per_byte is the congestion fee: algod reports it as `fee`
// on GET /v2/transactions/params, and it is 0 whenever the transaction
// pool is not full, which is nearly always. A signed single-sig payment
// with no note is about 250 bytes (msgpack: amt, fee, fv, lv, gen, gh,
// rcv, snd, type, plus the 64-byte signature), so the congestion term
// only overtakes the floor above 4 microAlgo per byte.
//
// Both inputs are read live from algod on every tick. One tier: the
// protocol has no priority auction beyond that congestion multiplier.

const algorandPaymentTxBytes = 250.0

type algorandFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindAlgorand, &algorandFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

type algodTxParams struct {
	Fee    *float64 `json:"fee"`
	MinFee *float64 `json:"min-fee"`
}

// algorandTransferFee returns the microAlgo cost of a payment of the given
// size under the given suggested fee per byte and minimum fee.
func algorandTransferFee(feePerByte, minFee, txBytes float64) float64 {
	fee := feePerByte * txBytes
	if fee < minFee {
		return minFee
	}
	return fee
}

func (f *algorandFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	var p algodTxParams
	if err := getJSON(f.http, ch.RPCURL+"/v2/transactions/params", &p); err != nil {
		return nil, fmt.Errorf("algod params: %w", err)
	}
	if p.MinFee == nil || *p.MinFee <= 0 || p.Fee == nil || *p.Fee < 0 {
		return nil, fmt.Errorf("algod params: missing min-fee or fee")
	}
	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "single",
		NativeFee: algorandTransferFee(*p.Fee, *p.MinFee, algorandPaymentTxBytes),
	}}, nil
}
