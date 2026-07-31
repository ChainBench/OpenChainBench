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

// etherscanMainnets is the pinned allowlist of V2 mainnet chain ids
// (audited 2026-07-07 against the keyless chainlist). Name-based
// testnet filtering is a time bomb: historical Etherscan testnets
// ("Amoy", "Fuji", "Chapel", "Moonbase Alpha") carry none of the
// obvious tokens. Chainlist entries NOT in this set and not name-
// flagged as testnets are EXCLUDED from registered and logged, so a
// new listing never silently moves the number before a human
// classifies it.
var etherscanMainnets = map[int64]bool{
	1: true, 56: true, 137: true, 8453: true, 42161: true,
	81457: true, 10: true, 43114: true, 199: true, 42220: true, 252: true,
	100: true, 5000: true, 4352: true, 1284: true, 1285: true, 204: true,
	167000: true, 50: true, 33139: true, 480: true, 146: true, 130: true,
	2741: true, 80094: true, 143: true, 999: true, 747474: true,
	737373: true, 1329: true, 988: true, 9745: true, 4326: true,
}

func probeEtherscan(keyIgnored string) coverage {
	key := envDefault("ETHERSCAN_API_KEY", "")
	_ = keyIgnored
	base := envDefault("ETHERSCAN_BASE_URL", etherscanBaseDefault)
	cov := coverage{registered: -1, registeredSource: "registry", verified: -1, verifiedStrict: -1, top50: -1}
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
	strict := 0
	anyOK := false
	probeWindow := func(chainID int64, window time.Duration) (bool, bool) {
		// returns (fresh, definitiveAnswer)
		since := time.Now().Add(-window).Unix()
		url := fmt.Sprintf("%s/v2/api?chainid=%d&module=block&action=getblocknobytime&timestamp=%d&closest=after&apikey=%s",
			base, chainID, since, key)
		raw, el, err := doCall("etherscan", "GET", url, map[string]string{"Accept": "application/json"}, nil)
		total += el
		if err != nil {
			quotaHit = quotaHit || isQuotaStatus(httpStatus(err))
			recordError("etherscan", err)
			return false, false
		}
		fresh, perr := parseEtherscanBlockNoByTime(raw)
		if perr != nil {
			if strings.Contains(perr.Error(), "rate limit") {
				quotaHit = true
			}
			recordError("etherscan", perr)
			return false, false
		}
		return fresh, true
	}
	for _, c := range chains {
		time.Sleep(sweepSpacing)
		fresh, ok := probeWindow(c.id, freshWindow)
		if !ok {
			continue
		}
		anyOK = true
		if !fresh {
			continue
		}
		verified++
		evmLive[c.id] = true
		nameLive[normalizeChainName(c.name)] = true
		time.Sleep(sweepSpacing)
		if s, ok2 := probeWindow(c.id, freshWindowStrict); ok2 && s {
			strict++
		}
	}

	if quotaHit {
		fmt.Printf("[etherscan] quota-class failures during cycle, publishing nothing\n")
		cov.registered, cov.verified, cov.verifiedStrict, cov.top50 = -1, -1, -1, -1
	} else if anyOK {
		cov.verified = verified
		cov.verifiedStrict = strict
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
	unclassified := 0
	for _, c := range resp.Result {
		id, err := c.ChainID.Int64()
		if err != nil || id == 0 {
			continue
		}
		if etherscanMainnets[id] {
			out = append(out, etherscanChain{id: id, name: c.ChainName})
			continue
		}
		lc := strings.ToLower(c.ChainName)
		if strings.Contains(lc, "testnet") || strings.Contains(lc, "sepolia") ||
			strings.Contains(lc, "holesky") || strings.Contains(lc, "goerli") ||
			strings.Contains(lc, "hoodi") {
			continue // known-testnet by name
		}
		// Neither allowlisted nor name-flagged: a NEW listing. Never
		// silently counted; excluded until a human classifies it.
		unclassified++
		fmt.Printf("[etherscan] UNCLASSIFIED chainlist entry %d (%s): excluded until pinned\n", id, c.ChainName)
	}
	_ = unclassified
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
	if strings.Contains(lr, "max calls per sec") {
		// Per-second throttle: transient, skip chain rather than aborting the cycle.
		return false, nil
	}
	if strings.Contains(lr, "rate limit") {
		return false, fmt.Errorf("etherscan rate limit: %s", resp.Result)
	}
	if strings.Contains(lr, "invalid api key") || strings.Contains(lr, "missing") {
		return false, fmt.Errorf("etherscan auth: %s", resp.Result)
	}
	return false, nil
}
