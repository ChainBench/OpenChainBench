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
// verified: GET /v1/wallets/<addr>/portfolio?currency=usd per wallet
//           in the shared EVM set — the shared sweep address plus
//           every funded 20-byte 0x probe wallet (see addresses.go).
//           Each call's positions_distribution_by_chain contributes
//           its > $1 chains. Zerion's wallet surface is EVM-only, so
//           non-EVM probe addresses are never submitted.
const zerionBaseDefault = "https://api.zerion.io"

func probeZerion(key string) coverage {
	base := envDefault("ZERION_BASE_URL", zerionBaseDefault)
	hdr := map[string]string{
		"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(key+":")),
		"Accept":        "application/json",
	}
	cov := coverage{listed: -1, listedSource: "declared", verified: -1, probed: -1}
	var total time.Duration

	// --- listed: self-declared chain catalog -----------------------
	raw, el, err := doCall("zerion", "GET", base+"/v1/chains/", hdr, nil)
	total += el
	catalog := map[string]bool{}
	if err != nil {
		recordError("zerion", err)
		fmt.Printf("[zerion] chains catalog failed: %v\n", err)
	} else if n, ids, perr := parseZerionChains(raw); perr != nil {
		recordError("zerion", perr)
		fmt.Printf("[zerion] chains parse failed: %v\n", perr)
	} else {
		cov.listed = n
		catalog = ids
	}

	// --- verified: one portfolio call per wallet in the EVM set ----
	// Zerion's dev tier throttles bursts on wallet endpoints (a call
	// issued right after another 429s while the isolated request
	// passes), so the sweep spaces calls wider than the shared
	// sweepSpacing, allows ONE long-backoff retry for the whole
	// cycle, and aborts the remaining sweep on a second 429 rather
	// than hammering the limit — publish-then-leave carries the
	// previous gauges forward.
	verified := map[string]bool{}
	probedMisses := 0
	anyOK := false
	retried429 := false
	wallets := append([]string{evmTestAddress}, evmProbeAddresses()...)
	namesByAddr := probeNamesByAddr()
	for i, wallet := range wallets {
		time.Sleep(zerionSweepSpacing)
		url := fmt.Sprintf("%s/v1/wallets/%s/portfolio?currency=usd", base, wallet)
		raw, el, err = doCall("zerion", "GET", url, hdr, nil)
		total += el
		if err != nil && strings.Contains(err.Error(), "http 429") {
			if retried429 {
				recordError("zerion", err)
				fmt.Printf("[zerion] second 429, aborting sweep at wallet %d/%d\n", i+1, len(wallets))
				break
			}
			retried429 = true
			fmt.Printf("[zerion] portfolio 429, retrying once in 60s\n")
			time.Sleep(60 * time.Second)
			raw, el, err = doCall("zerion", "GET", url, hdr, nil)
			total += el
		}
		if err != nil {
			recordError("zerion", err)
			fmt.Printf("[zerion] portfolio probe failed for %s: %v\n", wallet, err)
			continue
		}
		chains, perr := parseZerionPortfolio(raw)
		if perr != nil {
			recordError("zerion", perr)
			fmt.Printf("[zerion] portfolio parse failed for %s: %v\n", wallet, perr)
			continue
		}
		before := len(verified)
		for _, c := range chains {
			verified[c] = true
		}
		if i > 0 && len(verified) == before &&
			anyNameInSet(catalog, namesByAddr[wallet]) {
			// Funded probe wallet answered with nothing new AND its
			// target chain is in Zerion's own catalog: a real
			// indexer gap. Chains Zerion never listed do not count,
			// and a failed catalog call counts no miss at all.
			probedMisses++
		}
		anyOK = true
	}
	if anyOK {
		cov.verified = len(verified)
		cov.probed = len(verified) + probedMisses
	}
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// parseZerionChains counts data[].id entries in the chain catalog and
// returns the normalized id set for probe-miss intersection.
func parseZerionChains(raw []byte) (int, map[string]bool, error) {
	var resp struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return 0, nil, fmt.Errorf("parse chains: %w", err)
	}
	n := 0
	set := map[string]bool{}
	for _, c := range resp.Data {
		if c.ID != "" {
			n++
			set[normalizeChainName(c.ID)] = true
		}
	}
	return n, set, nil
}

// zerionSweepSpacing is wider than the shared sweepSpacing because
// Zerion's dev tier is the burst-touchiest upstream in the cohort.
const zerionSweepSpacing = 5 * time.Second

// parseZerionPortfolio returns the chain ids carrying > $1 in
// attributes.positions_distribution_by_chain. The map values are
// already USD (currency=usd), so no fallback path is needed.
func parseZerionPortfolio(raw []byte) ([]string, error) {
	var resp struct {
		Data struct {
			Attributes struct {
				PositionsDistributionByChain map[string]float64 `json:"positions_distribution_by_chain"`
			} `json:"attributes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("parse portfolio: %w", err)
	}
	var out []string
	for chain, usd := range resp.Data.Attributes.PositionsDistributionByChain {
		if usd > verifiedUsdThreshold {
			out = append(out, chain)
		}
	}
	return out, nil
}
