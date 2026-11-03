package main

import (
	"fmt"
	"net/http"
	"time"
)

// Aptos native-transfer fee sampler.
//
// An Aptos transaction pays gas_used * gas_unit_price octas (1 APT =
// 10^8 octas). The fullnode publishes the current price per gas unit at
// three levels on GET /v1/estimate_gas_price:
//
//   deprioritized_gas_estimate  -> slow
//   gas_estimate                -> std
//   prioritized_gas_estimate    -> fast
//
// gas_used for an `0x1::aptos_account::transfer` of APT to an account
// that already exists is 62 to 66 units. Measured 2026-11-03 from the
// indexer's GasFeeEvent amounts on the 30 most recent such transfers:
// 6200 to 6600 octas at 100 octas per unit. We publish 63 units, the
// median. A transfer that creates the recipient account also pays the
// storage fee for the new account resource and costs about 5400 units;
// that is account creation, not a transfer, and out of scope here like on
// the other chains.
//
// The price is live every tick; the gas units are the measured constant
// (the same discipline as the Sui and Solana rows, whose unit counts are
// also fixed per transaction type).

const aptosTransferGasUnits = 63.0

type aptosFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindAptos, &aptosFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

type aptosGasEstimate struct {
	Deprioritized float64 `json:"deprioritized_gas_estimate"`
	Standard      float64 `json:"gas_estimate"`
	Prioritized   float64 `json:"prioritized_gas_estimate"`
}

// aptosTierSamples turns the three gas price estimates into fee samples
// in octas. A missing deprioritized or prioritized estimate falls back to
// the standard one, which is the only field the API guarantees.
func aptosTierSamples(slug string, e aptosGasEstimate) ([]FeeSample, error) {
	if e.Standard <= 0 {
		return nil, fmt.Errorf("aptos gas_estimate missing")
	}
	slow, fast := e.Deprioritized, e.Prioritized
	if slow <= 0 {
		slow = e.Standard
	}
	if fast <= 0 {
		fast = e.Standard
	}
	out := make([]FeeSample, 0, 3)
	for _, t := range []struct {
		tier  string
		price float64
	}{{"slow", slow}, {"std", e.Standard}, {"fast", fast}} {
		out = append(out, FeeSample{
			Chain:     slug,
			Tier:      t.tier,
			NativeFee: t.price * aptosTransferGasUnits,
		})
	}
	return out, nil
}

func (f *aptosFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	var e aptosGasEstimate
	if err := getJSON(f.http, ch.RPCURL+"/estimate_gas_price", &e); err != nil {
		return nil, fmt.Errorf("aptos estimate_gas_price: %w", err)
	}
	return aptosTierSamples(ch.Slug, e)
}
