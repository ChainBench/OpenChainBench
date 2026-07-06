package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Zerion v1. Auth is HTTP Basic with the API key as username and an
// empty password.
//
// listed:   GET /v1/chains/ — data[].id is the vendor's stable chain
//           identifier.
// verified: GET /v1/wallets/<EVM>/portfolio?currency=usd — the
//           attributes.positions_distribution_by_chain map gives a
//           USD figure per chain in a single call. Zerion's wallet
//           portfolio surface is EVM-only, so only the EVM test
//           address is probed (2 calls per cycle total).
const zerionBaseDefault = "https://api.zerion.io"

func probeZerion(key string) coverage {
	base := envDefault("ZERION_BASE_URL", zerionBaseDefault)
	hdr := map[string]string{
		"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(key+":")),
		"Accept":        "application/json",
	}
	cov := coverage{listed: -1, listedSource: "declared", verified: -1}
	var total time.Duration

	// --- listed: self-declared chain catalog -----------------------
	raw, el, err := doCall("zerion", "GET", base+"/v1/chains/", hdr, nil)
	total += el
	if err != nil {
		recordError("zerion", err)
		fmt.Printf("[zerion] chains catalog failed: %v\n", err)
	} else if n, perr := parseZerionChains(raw); perr != nil {
		recordError("zerion", perr)
		fmt.Printf("[zerion] chains parse failed: %v\n", perr)
	} else {
		cov.listed = n
	}

	// --- verified: one portfolio call for the EVM address ----------
	// Zerion's dev tier throttles bursts on wallet endpoints: the
	// portfolio call 429s when issued right after the chains call,
	// while the same isolated request passes. Space the two calls,
	// and give one long-backoff retry on 429 (429 is excluded from
	// the generic retry to avoid hammering rate limits elsewhere).
	time.Sleep(10 * time.Second)
	url := fmt.Sprintf("%s/v1/wallets/%s/portfolio?currency=usd", base, evmTestAddress)
	raw, el, err = doCall("zerion", "GET", url, hdr, nil)
	if err != nil && strings.Contains(err.Error(), "http 429") {
		fmt.Printf("[zerion] portfolio 429, retrying once in 60s\n")
		time.Sleep(60 * time.Second)
		raw, el, err = doCall("zerion", "GET", url, hdr, nil)
	}
	total += el
	if err != nil {
		recordError("zerion", err)
		fmt.Printf("[zerion] portfolio probe failed: %v\n", err)
	} else if n, perr := parseZerionPortfolio(raw); perr != nil {
		recordError("zerion", perr)
		fmt.Printf("[zerion] portfolio parse failed: %v\n", perr)
	} else {
		cov.verified = n
	}

	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// parseZerionChains counts data[].id entries in the chain catalog.
func parseZerionChains(raw []byte) (int, error) {
	var resp struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return 0, fmt.Errorf("parse chains: %w", err)
	}
	n := 0
	for _, c := range resp.Data {
		if c.ID != "" {
			n++
		}
	}
	return n, nil
}

// parseZerionPortfolio counts chains carrying > $1 in
// attributes.positions_distribution_by_chain. The map values are
// already USD (currency=usd), so no fallback path is needed.
func parseZerionPortfolio(raw []byte) (int, error) {
	var resp struct {
		Data struct {
			Attributes struct {
				PositionsDistributionByChain map[string]float64 `json:"positions_distribution_by_chain"`
			} `json:"attributes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return 0, fmt.Errorf("parse portfolio: %w", err)
	}
	n := 0
	for _, usd := range resp.Data.Attributes.PositionsDistributionByChain {
		if usd > verifiedUsdThreshold {
			n++
		}
	}
	return n, nil
}
