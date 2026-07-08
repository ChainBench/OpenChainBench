package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// Routescan. Fully keyless (2 rps anonymous, headers observed:
// 120/min, 10k/day — a cycle spends ~37 calls).
//
// registered: GET /v2/network/mainnet/evm/all/blockchains — the
//             public free-tier chain list.
// verified:   per chain GET /v2/network/mainnet/evm/{id}/blocks?limit=1
//             and gate items[0].timestamp on the freshness window.
const routescanBaseDefault = "https://api.routescan.io"

func probeRoutescan(_ string) coverage {
	base := envDefault("ROUTESCAN_BASE_URL", routescanBaseDefault)
	cov := coverage{registered: -1, registeredSource: "registry", verified: -1, verifiedStrict: -1, top50: -1}
	var total time.Duration

	raw, el, err := doCall("routescan", "GET", base+"/v2/network/mainnet/evm/all/blockchains", map[string]string{"Accept": "application/json"}, nil)
	total += el
	if err != nil {
		recordError("routescan", err)
		fmt.Printf("[routescan] blockchains list failed: %v\n", err)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	chains, perr := parseRoutescanChains(raw)
	if perr != nil {
		recordError("routescan", perr)
		fmt.Printf("[routescan] blockchains parse failed: %v\n", perr)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	cov.registered = len(chains)

	evmLive := map[int64]bool{}
	nameLive := map[string]bool{}
	verified := 0
	strict := 0
	anyOK := false
	quotaHit := false
	for _, c := range chains {
		time.Sleep(sweepSpacing)
		url := fmt.Sprintf("%s/v2/network/mainnet/evm/%d/blocks?limit=1", base, c.id)
		raw, el, err := doCall("routescan", "GET", url, map[string]string{"Accept": "application/json"}, nil)
		total += el
		if err != nil {
			if isQuotaStatus(httpStatus(err)) {
				quotaHit = true
				recordError("routescan", err)
				continue
			}
			// Per-chain refusal: definitive, the chain is not served.
			anyOK = true
			continue
		}
		ts, perr := parseRoutescanLatestBlock(raw)
		anyOK = true
		if perr == nil && freshEnough(ts) {
			verified++
			if freshStrict(ts) {
				strict++
			}
			evmLive[c.id] = true
			nameLive[normalizeChainName(c.name)] = true
		}
	}

	if quotaHit {
		fmt.Printf("[routescan] quota-class failures during cycle, publishing nothing\n")
		cov.registered, cov.verified, cov.top50 = -1, -1, -1
	} else if anyOK {
		cov.verified = verified
		cov.verifiedStrict = strict
		cov.top50 = top50Count(evmLive, nameLive)
	}
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

type routescanChain struct {
	id   int64
	name string
}

// parseRoutescanChains tolerates both {items:[...]} and a bare array.
func parseRoutescanChains(raw []byte) ([]routescanChain, error) {
	type row struct {
		ChainID json.Number `json:"chainId"`
		Name    string      `json:"name"`
	}
	var wrapped struct {
		Items []row `json:"items"`
	}
	rows := wrapped.Items
	if err := json.Unmarshal(raw, &wrapped); err != nil || len(wrapped.Items) == 0 {
		var arr []row
		if err2 := json.Unmarshal(raw, &arr); err2 != nil || len(arr) == 0 {
			return nil, fmt.Errorf("parse blockchains: unexpected shape: %s", truncate(string(raw), 120))
		}
		rows = arr
	} else {
		rows = wrapped.Items
	}
	var out []routescanChain
	for _, r := range rows {
		id, err := r.ChainID.Int64()
		if err != nil || id == 0 {
			continue
		}
		out = append(out, routescanChain{id: id, name: r.Name})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("parse blockchains: no usable rows")
	}
	return out, nil
}

// parseRoutescanLatestBlock reads items[0].timestamp (ISO 8601).
func parseRoutescanLatestBlock(raw []byte) (time.Time, error) {
	var resp struct {
		Items []struct {
			Timestamp string `json:"timestamp"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return time.Time{}, fmt.Errorf("parse blocks: %w", err)
	}
	if len(resp.Items) == 0 || resp.Items[0].Timestamp == "" {
		return time.Time{}, fmt.Errorf("parse blocks: no items")
	}
	t, err := time.Parse(time.RFC3339, resp.Items[0].Timestamp)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse blocks timestamp: %w", err)
	}
	return t, nil
}
