package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// Blockchair. Fully keyless (soft limit ~1440 req/day; a cycle spends
// ~15 calls).
//
// registered: GET api.blockchair.com/stats — the aggregate stats
//             endpoint, one key per supported chain.
// verified:   per chain GET /{chain}/stats and gate
//             data.best_block_time ("YYYY-MM-DD HH:MM:SS", UTC, no
//             suffix) on the freshness window.
const blockchairBaseDefault = "https://api.blockchair.com"

func probeBlockchair(_ string) coverage {
	base := envDefault("BLOCKCHAIR_BASE_URL", blockchairBaseDefault)
	cov := coverage{registered: -1, registeredSource: "registry", verified: -1, verifiedStrict: -1, top50: -1}
	var total time.Duration

	raw, el, err := doCall("blockchair", "GET", base+"/stats", map[string]string{"Accept": "application/json"}, nil)
	total += el
	if err != nil {
		recordError("blockchair", err)
		fmt.Printf("[blockchair] aggregate stats failed: %v\n", err)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	chains, perr := parseBlockchairAggregate(raw)
	if perr != nil {
		recordError("blockchair", perr)
		fmt.Printf("[blockchair] aggregate parse failed: %v\n", perr)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	cov.registered = len(chains)

	nameLive := map[string]bool{}
	verified := 0
	strict := 0
	anyOK := false
	quotaHit := false
	for _, chain := range chains {
		time.Sleep(sweepSpacing)
		raw, el, err := doCall("blockchair", "GET", base+"/"+chain+"/stats", map[string]string{"Accept": "application/json"}, nil)
		total += el
		if err != nil {
			if isQuotaStatus(httpStatus(err)) {
				quotaHit = true
				recordError("blockchair", err)
				continue
			}
			anyOK = true
			continue
		}
		ts, perr := parseBlockchairBestBlockTime(raw)
		anyOK = true
		if perr == nil && freshEnough(ts) {
			verified++
			if freshStrict(ts) {
				strict++
			}
			nameLive[normalizeChainName(chain)] = true
			// blockchair keys are dashed names ("bitcoin-cash"); also
			// index the undashed form for top-50 alias matching.
		}
	}

	if quotaHit {
		fmt.Printf("[blockchair] quota-class failures during cycle, publishing nothing\n")
		cov.registered, cov.verified, cov.top50 = -1, -1, -1
	} else if anyOK {
		cov.verified = verified
		cov.verifiedStrict = strict
		cov.top50 = top50Count(map[int64]bool{}, nameLive)
	}
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// parseBlockchairAggregate returns the chain keys of the aggregate
// stats payload ({"data": {"bitcoin": {...}, ...}}).
func parseBlockchairAggregate(raw []byte) ([]string, error) {
	var resp struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("parse aggregate: %w", err)
	}
	if len(resp.Data) == 0 {
		return nil, fmt.Errorf("parse aggregate: empty data")
	}
	out := make([]string, 0, len(resp.Data))
	for k := range resp.Data {
		out = append(out, k)
	}
	return out, nil
}

// parseBlockchairBestBlockTime reads data.best_block_time, format
// "2026-07-07 13:24:11" in UTC without a timezone suffix.
func parseBlockchairBestBlockTime(raw []byte) (time.Time, error) {
	var resp struct {
		Data struct {
			BestBlockTime string `json:"best_block_time"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return time.Time{}, fmt.Errorf("parse stats: %w", err)
	}
	if resp.Data.BestBlockTime == "" {
		return time.Time{}, fmt.Errorf("parse stats: no best_block_time")
	}
	t, err := time.ParseInLocation("2006-01-02 15:04:05", resp.Data.BestBlockTime, time.UTC)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse best_block_time: %w", err)
	}
	return t, nil
}
