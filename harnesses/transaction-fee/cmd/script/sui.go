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
// A Sui transaction pays computation plus storage, minus the storage
// rebate of the objects it rewrites:
//
//   fee_mist = computation_units * reference_gas_price
//            + storage_cost - storage_rebate
//
// A wallet "send X SUI" is SplitCoins(gas, X) + TransferObjects: it
// creates one new Coin<SUI> object for the recipient and rewrites the
// gas coin. Measured on mainnet 2026-11-03 through GraphQL gasSummary:
//
//   computation  1000 units (the minimum bucket) at the reference price
//                (100 MIST today): 100_000 MIST
//   storage      988_000 MIST per Coin<SUI> object (13_000 storage units
//                at the 76 MIST storage price). The new coin costs
//                988_000; the rewritten gas coin costs 988_000 and gets
//                987_901 back (the 0.01 % non refundable share), so it
//                nets 99.
//
// Total about 1_088_099 MIST (0.00109 SUI). The previous model
// multiplied the reference price by a 76_000 "gas budget", which at
// today's 100 MIST price read 7_600_000 MIST, about seven times what a
// transfer pays.
//
// The reference gas price is read live every tick from the GraphQL
// endpoint; the unit counts and the storage price are protocol constants.
// One "std" tier: Sui gas pricing is effectively flat at the reference
// price.

const (
	suiTransferComputationUnits = 1000.0
	suiNewCoinStorageMist       = 988_000.0
	suiGasCoinNetStorageMist    = 99.0
)

// suiTransferFeeMist is the MIST cost of a SplitCoins + TransferObjects
// SUI transfer at the given reference gas price.
func suiTransferFeeMist(referenceGasPrice float64) float64 {
	return suiTransferComputationUnits*referenceGasPrice + suiNewCoinStorageMist + suiGasCoinNetStorageMist
}

type suiFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindSui, &suiFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

func (f *suiFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	// JSON-RPC on the public fullnodes was retired in 2026 ("Method not
	// found ... migrate to gRPC or GraphQL"); the reference gas price now
	// comes from the GraphQL endpoint.
	body, _ := json.Marshal(map[string]string{"query": "{ epoch { referenceGasPrice } }"})
	resp, err := f.http.Post(ch.RPCURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:min(len(raw), 200)]))
	}
	var r struct {
		Data struct {
			Epoch struct {
				ReferenceGasPrice string `json:"referenceGasPrice"`
			} `json:"epoch"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("decode sui graphql: %w", err)
	}
	if len(r.Errors) > 0 {
		return nil, fmt.Errorf("graphql error: %s", r.Errors[0].Message)
	}
	gasPrice, err := strconv.ParseInt(r.Data.Epoch.ReferenceGasPrice, 10, 64)
	if err != nil || gasPrice <= 0 {
		return nil, fmt.Errorf("bad reference gas price: %q", r.Data.Epoch.ReferenceGasPrice)
	}
	feeMist := suiTransferFeeMist(float64(gasPrice))
	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "std",
		NativeFee: feeMist,
		GasPrice:  float64(gasPrice),
	}}, nil
}
