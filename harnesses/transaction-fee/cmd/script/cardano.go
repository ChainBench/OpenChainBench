package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Cardano native-transfer fee sampler.
//
// Cardano fees are deterministic, set by the on-chain protocol parameters:
//
//   fee_lovelace = min_fee_b + (tx_size_bytes * min_fee_a)
//
// where min_fee_a (per-byte coefficient) and min_fee_b (constant base) are
// part of the live protocol parameters. As of recent epochs the values are
// 44 lovelace/byte and 155381 lovelace base. A standard ADA payment with
// one input + two outputs is ~250 bytes — we hardcode that as our "typical
// transfer size" so the result reflects the cost of a real native send.
//
// We pull the live coefficients from Koios:
//   GET https://api.koios.rest/api/v1/epoch_params
// returning an array of recent epochs (latest first). We take rows[0].
//
// If Koios is unreachable or returns junk we fall back to the hardcoded
// constants 155381 + 44 * 250 so the gauge keeps producing an honest
// number rather than going stale. Errors are bubbled up only when even the
// fallback can't satisfy the contract (i.e. never, in practice).
//
// Result is one FeeSample with Tier="single" in lovelace; main.go divides
// by 10^6 to convert to ADA before applying the USD price.

const (
	cardanoTypicalTxBytes  = 250.0
	cardanoFallbackMinFeeA = 44.0
	cardanoFallbackMinFeeB = 155381.0
)

type cardanoFetcher struct {
	http *http.Client
}

func init() {
	registerFetcher(KindCardano, &cardanoFetcher{http: &http.Client{Timeout: 8 * time.Second}})
}

type koiosEpochParams struct {
	MinFeeA float64 `json:"min_fee_a"`
	MinFeeB float64 `json:"min_fee_b"`
}

// Koios epoch params change once per 5-day epoch, but this fetcher runs
// on the 30s harness cycle. Caching for an hour keeps the total koios
// load around 24 calls/day (both OCB harnesses combined stay far under
// the 5,000/day public tier that we exhausted before this cache).
var cardanoParamCache struct {
	minFeeA, minFeeB float64
	fetchedAt        time.Time
}

func (f *cardanoFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	if time.Since(cardanoParamCache.fetchedAt) < time.Hour && cardanoParamCache.minFeeA > 0 {
		feeLovelace := cardanoParamCache.minFeeB + (cardanoTypicalTxBytes * cardanoParamCache.minFeeA)
		return []FeeSample{{Chain: ch.Slug, Tier: "single", NativeFee: feeLovelace}}, nil
	}
	minFeeA, minFeeB, err := f.fetchProtocolParams(ch.RPCURL)
	if err == nil {
		cardanoParamCache.minFeeA, cardanoParamCache.minFeeB = minFeeA, minFeeB
		cardanoParamCache.fetchedAt = time.Now()
	}
	if err != nil {
		// Fall back to known-good constants rather than emit nothing.
		fmt.Printf("[cardano] koios fetch failed, using fallback constants: %v\n", err)
		minFeeA = cardanoFallbackMinFeeA
		minFeeB = cardanoFallbackMinFeeB
	}

	feeLovelace := minFeeB + (cardanoTypicalTxBytes * minFeeA)

	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "single",
		NativeFee: feeLovelace,
	}}, nil
}

func (f *cardanoFetcher) fetchProtocolParams(baseURL string) (float64, float64, error) {
	url := baseURL + "/epoch_params"
	resp, err := f.http.Get(url)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		end := len(raw)
		if end > 200 {
			end = 200
		}
		return 0, 0, fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:end]))
	}
	var rows []koiosEpochParams
	if err := json.Unmarshal(raw, &rows); err != nil {
		return 0, 0, fmt.Errorf("decode koios response: %w", err)
	}
	if len(rows) == 0 {
		return 0, 0, fmt.Errorf("empty epoch_params array")
	}
	p := rows[0]
	if p.MinFeeA <= 0 || p.MinFeeB <= 0 {
		return 0, 0, fmt.Errorf("invalid params: min_fee_a=%v min_fee_b=%v", p.MinFeeA, p.MinFeeB)
	}
	return p.MinFeeA, p.MinFeeB, nil
}
