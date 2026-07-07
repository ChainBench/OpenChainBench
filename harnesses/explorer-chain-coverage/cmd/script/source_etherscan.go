package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Etherscan API V2 (one key, multichain).
//
// registered: GET api.etherscan.io/v2/chainlist — KEYLESS, returns
//             every V2 chain with its own status field. Mainnets
//             only (testnets filtered by name).
// verified:   per mainnet chain, one keyed call to
//             module=block&action=getblocknobytime with a timestamp
//             one freshness-window ago and closest=after. The call
//             queries their INDEX (unlike module=proxy, which can
//             pass through to a node): a block found after that
//             timestamp proves the index is fresh. Free key,
//             3 calls/s, 100k/day — a cycle spends ~35 calls.
const etherscanBaseDefault = "https://api.etherscan.io"

func probeEtherscan(keyIgnored string) coverage {
	key := envDefault("ETHERSCAN_API_KEY", "")
	_ = keyIgnored
	base := envDefault("ETHERSCAN_BASE_URL", etherscanBaseDefault)
	cov := coverage{registered: -1, registeredSource: "registry", verified: -1, top50: -1}
	var total time.Duration
	quotaHit := false

	raw, el, err := doCall("etherscan", "GET", base+"/v2/chainlist", map[string]string{"Accept": "application/json"}, nil)
	total += el
	if err != nil {
		recordError("etherscan", err)
		fmt.Printf("[etherscan] chainlist failed: %v\n", err)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	chains, perr := parseEtherscanChainlist(raw)
	if perr != nil {
		recordError("etherscan", perr)
		fmt.Printf("[etherscan] chainlist parse failed: %v\n", perr)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	cov.registered = len(chains)

	if key == "" {
		// Keyless mode: the chainlist needs no auth, the freshness
		// probes do. Publish registered, leave verified unknown.
		fmt.Printf("[etherscan] no ETHERSCAN_API_KEY: publishing registered only (%d mainnets)\n", len(chains))
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}

	evmLive := map[int64]bool{}
	nameLive := map[string]bool{}
	verified := 0
	anyOK := false
	for _, c := range chains {
		time.Sleep(sweepSpacing)
		since := time.Now().Add(-freshWindow).Unix()
		url := fmt.Sprintf("%s/v2/api?chainid=%d&module=block&action=getblocknobytime&timestamp=%d&closest=after&apikey=%s",
			base, c.id, since, key)
		raw, el, err := doCall("etherscan", "GET", url, map[string]string{"Accept": "application/json"}, nil)
		total += el
		if err != nil {
			quotaHit = quotaHit || isQuotaStatus(httpStatus(err))
			recordError("etherscan", err)
			continue
		}
		fresh, perr := parseEtherscanBlockNoByTime(raw)
		if perr != nil {
			if strings.Contains(perr.Error(), "rate limit") {
				// Their throttle answers HTTP 200 with an error
				// string; treat like a 429.
				quotaHit = true
				recordError("etherscan", perr)
				continue
			}
			// "No record found" style answers mean the index has no
			// block in the window: stale, a definitive answer.
			anyOK = true
			continue
		}
		anyOK = true
		if fresh {
			verified++
			evmLive[c.id] = true
			nameLive[normalizeChainName(c.name)] = true
		}
	}

	if quotaHit {
		fmt.Printf("[etherscan] quota-class failures during cycle, publishing nothing\n")
		cov.registered, cov.verified, cov.top50 = -1, -1, -1
	} else if anyOK {
		cov.verified = verified
		cov.top50 = top50Count(evmLive, nameLive)
	}
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

type etherscanChain struct {
	id   int64
	name string
}

// parseEtherscanChainlist returns V2 mainnet chains (testnets are
// filtered by name: their chainlist has no testnet flag).
func parseEtherscanChainlist(raw []byte) ([]etherscanChain, error) {
	var resp struct {
		Result []struct {
			ChainName string      `json:"chainname"`
			ChainID   json.Number `json:"chainid"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("parse chainlist: %w", err)
	}
	if len(resp.Result) == 0 {
		return nil, fmt.Errorf("parse chainlist: empty result")
	}
	var out []etherscanChain
	for _, c := range resp.Result {
		lc := strings.ToLower(c.ChainName)
		if strings.Contains(lc, "testnet") || strings.Contains(lc, "sepolia") ||
			strings.Contains(lc, "holesky") || strings.Contains(lc, "goerli") ||
			strings.Contains(lc, "hoodi") {
			continue
		}
		id, err := c.ChainID.Int64()
		if err != nil || id == 0 {
			continue
		}
		out = append(out, etherscanChain{id: id, name: c.ChainName})
	}
	return out, nil
}

// parseEtherscanBlockNoByTime: status "1" with a numeric result means
// a block exists after the probe timestamp (fresh index). status "0"
// with "No record found"-ish messages means stale — returned as
// (false, nil). Rate-limit strings surface as errors.
func parseEtherscanBlockNoByTime(raw []byte) (bool, error) {
	var resp struct {
		Status  string `json:"status"`
		Message string `json:"message"`
		Result  string `json:"result"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return false, fmt.Errorf("parse getblocknobytime: %w", err)
	}
	if resp.Status == "1" && resp.Result != "" {
		return true, nil
	}
	lr := strings.ToLower(resp.Result + " " + resp.Message)
	if strings.Contains(lr, "rate limit") {
		return false, fmt.Errorf("etherscan rate limit: %s", resp.Result)
	}
	if strings.Contains(lr, "invalid api key") || strings.Contains(lr, "missing") {
		return false, fmt.Errorf("etherscan auth: %s", resp.Result)
	}
	return false, nil
}
