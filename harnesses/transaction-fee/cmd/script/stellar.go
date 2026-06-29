package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Stellar native-transfer fee sampler.
//
// Stellar charges base_fee * num_operations per transaction. A native XLM
// payment is exactly one operation, so the fee is `last_ledger_base_fee`
// stroops. The nominal base is 100 stroops, but Stellar uses surge pricing:
// when a ledger is full, the base rises (the network-wide minimum bid is
// effectively bumped). We read the current bid from Horizon /fee_stats:
//
//   GET https://horizon.stellar.org/fee_stats
//
// which returns `last_ledger_base_fee` (stringified stroops) along with
// percentiles of recently-charged fees. We only need the base for a
// deterministic single-op payment.
//
// Result is one FeeSample with Tier="single" in stroops; main.go divides
// by 10^7 to convert to XLM before applying the USD price.

const stellarNominalBaseFeeStroops = 100.0

type stellarFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindStellar, &stellarFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

type horizonFeeStats struct {
	LastLedgerBaseFee string `json:"last_ledger_base_fee"`
}

func (f *stellarFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	baseFee, err := f.fetchBaseFee(ch.RPCURL)
	if err != nil {
		return nil, fmt.Errorf("stellar fee_stats: %w", err)
	}

	// One operation per native payment.
	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "single",
		NativeFee: baseFee,
	}}, nil
}

func (f *stellarFetcher) fetchBaseFee(baseURL string) (float64, error) {
	url := baseURL + "/fee_stats"
	resp, err := f.http.Get(url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		end := len(raw)
		if end > 200 {
			end = 200
		}
		return 0, fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:end]))
	}
	var r horizonFeeStats
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, fmt.Errorf("decode fee_stats: %w", err)
	}
	if r.LastLedgerBaseFee == "" {
		return stellarNominalBaseFeeStroops, nil
	}
	v, err := strconv.ParseFloat(r.LastLedgerBaseFee, 64)
	if err != nil {
		return 0, fmt.Errorf("parse last_ledger_base_fee=%q: %w", r.LastLedgerBaseFee, err)
	}
	if v <= 0 {
		return stellarNominalBaseFeeStroops, nil
	}
	return v, nil
}
