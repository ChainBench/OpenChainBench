package main

import (
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// Internet Computer (ICP) native-transfer fee sampler.
//
// What a user pays to send ICP is the ICP ledger's transfer fee, charged
// to the sender in ICP: 10_000 e8s (0.0001 ICP), a ledger parameter that has not
// moved since launch. Cycles (the gas of canister execution) are paid by the
// canister's developer, not by the person sending ICP, so they are not
// part of the user-facing fee and not added here.
//
// The fee is read live from the DFINITY ICP Rosetta node,
// POST /construction/metadata, field suggested_fee[0] (value in e8s,
// decimals 8), which is the ledger's transfer_fee. Reading it rather
// than hardcoding it means a governance change to the ledger fee shows
// up on the board. One tier: the ledger has no priority market.

const icpRosettaNetwork = "00000000000000020101"

type icpFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindICP, &icpFetcher{http: &http.Client{Timeout: 10 * time.Second}})
}

type rosettaMetadataResp struct {
	SuggestedFee []struct {
		Value    string `json:"value"`
		Currency struct {
			Symbol   string `json:"symbol"`
			Decimals int    `json:"decimals"`
		} `json:"currency"`
	} `json:"suggested_fee"`
}

// icpFeeE8s extracts the ICP transfer fee in e8s from a Rosetta
// construction/metadata answer, refusing anything that is not ICP with
// 8 decimals so a unit change cannot be published silently.
func icpFeeE8s(r rosettaMetadataResp) (float64, error) {
	for _, f := range r.SuggestedFee {
		if f.Currency.Symbol != "ICP" {
			continue
		}
		if f.Currency.Decimals != 8 {
			return 0, fmt.Errorf("icp fee: unexpected decimals %d", f.Currency.Decimals)
		}
		v, err := strconv.ParseFloat(f.Value, 64)
		if err != nil || v <= 0 {
			return 0, fmt.Errorf("icp fee: bad value %q", f.Value)
		}
		return v, nil
	}
	return 0, fmt.Errorf("icp fee: no ICP suggested_fee")
}

func (f *icpFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	var r rosettaMetadataResp
	body := map[string]any{
		"network_identifier": map[string]string{"blockchain": "Internet Computer", "network": icpRosettaNetwork},
		"options":            map[string]any{},
	}
	if err := postJSON(f.http, ch.RPCURL+"/construction/metadata", body, &r); err != nil {
		return nil, fmt.Errorf("icp rosetta metadata: %w", err)
	}
	e8s, err := icpFeeE8s(r)
	if err != nil {
		return nil, err
	}
	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "single",
		NativeFee: e8s,
	}}, nil
}
