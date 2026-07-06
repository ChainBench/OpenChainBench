package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"time"
)

// Dune (Sim APIs). Auth is the raw key in the X-Sim-Api-Key header.
//
// listed:   GET /v1/evm/supported-chains — one entry per chain with
//           per-endpoint support flags; a chain counts when
//           balances.supported is true (the capability this bench
//           probes).
// verified: GET /v1/evm/balances/<EVM>?exclude_spam_tokens=true — one
//           paginated sweep across every chain Sim indexes. A chain
//           counts when its summed value_usd clears the shared
//           threshold, with the usual native-amount fallback when a
//           chain's rows carry no pricing at all. Sim's stable
//           surface is EVM-only (SVM balances are still beta), so
//           only the EVM test address is probed.
const duneBaseDefault = "https://api.sim.dune.com"

// dunePageCap bounds the balances pagination. 1000 rows per page with
// spam filtered out is already beyond what the test wallet returns;
// the cap only guards against a runaway cursor.
const dunePageCap = 5

func probeDune(key string) coverage {
	base := envDefault("DUNE_SIM_BASE_URL", duneBaseDefault)
	hdr := map[string]string{"X-Sim-Api-Key": key, "Accept": "application/json"}
	cov := coverage{listed: -1, listedSource: "declared", verified: -1}
	var total time.Duration

	// --- listed: self-declared chain catalog -----------------------
	raw, el, err := doCall("GET", base+"/v1/evm/supported-chains", hdr, nil)
	total += el
	if err != nil {
		recordError("dune", err)
		fmt.Printf("[dune] supported-chains catalog failed: %v\n", err)
	} else if n, perr := parseDuneSupportedChains(raw); perr != nil {
		recordError("dune", perr)
		fmt.Printf("[dune] supported-chains parse failed: %v\n", perr)
	} else {
		cov.listed = n
	}

	// --- verified: one paginated balances sweep ---------------------
	agg := map[string]*duneChainAgg{}
	swept := false
	offset := ""
	for page := 0; page < dunePageCap; page++ {
		u := fmt.Sprintf("%s/v1/evm/balances/%s?exclude_spam_tokens=true&limit=1000",
			base, evmTestAddress)
		if offset != "" {
			u += "&offset=" + url.QueryEscape(offset)
		}
		raw, el, err := doCall("GET", u, hdr, nil)
		total += el
		if err != nil {
			recordError("dune", err)
			fmt.Printf("[dune] balances probe failed (page %d): %v\n", page+1, err)
			break
		}
		next, perr := parseDuneBalancesPage(raw, agg)
		if perr != nil {
			recordError("dune", perr)
			fmt.Printf("[dune] balances parse failed (page %d): %v\n", page+1, perr)
			break
		}
		swept = true
		if next == "" {
			break
		}
		offset = next
	}
	if swept {
		cov.verified = duneVerifiedCount(agg)
	}

	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// parseDuneSupportedChains counts catalog chains whose balances
// endpoint is flagged supported.
func parseDuneSupportedChains(raw []byte) (int, error) {
	var resp struct {
		Chains []struct {
			Name     string `json:"name"`
			Balances struct {
				Supported bool `json:"supported"`
			} `json:"balances"`
		} `json:"chains"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return 0, fmt.Errorf("parse supported-chains: %w", err)
	}
	if resp.Chains == nil {
		return 0, fmt.Errorf("parse supported-chains: no chains array: %s", truncate(string(raw), 120))
	}
	n := 0
	for _, c := range resp.Chains {
		if c.Balances.Supported {
			n++
		}
	}
	return n, nil
}

// duneChainAgg accumulates one chain's rows across balance pages so
// the shared threshold applies to the chain total, not per row.
type duneChainAgg struct {
	usd       float64
	anyPrice  bool
	anyAmount bool
}

// parseDuneBalancesPage folds one balances page into agg and returns
// the next_offset cursor ("" when the sweep is complete). Amounts are
// raw-unit strings; any non-zero string counts for the native
// fallback.
func parseDuneBalancesPage(raw []byte, agg map[string]*duneChainAgg) (string, error) {
	var resp struct {
		Balances []struct {
			Chain    string  `json:"chain"`
			Amount   string  `json:"amount"`
			PriceUSD float64 `json:"price_usd"`
			ValueUSD float64 `json:"value_usd"`
		} `json:"balances"`
		NextOffset string `json:"next_offset"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return "", fmt.Errorf("parse balances: %w", err)
	}
	if resp.Balances == nil {
		return "", fmt.Errorf("parse balances: no balances array: %s", truncate(string(raw), 120))
	}
	for _, b := range resp.Balances {
		if b.Chain == "" {
			continue
		}
		a := agg[b.Chain]
		if a == nil {
			a = &duneChainAgg{}
			agg[b.Chain] = a
		}
		if b.PriceUSD > 0 || b.ValueUSD > 0 {
			a.anyPrice = true
		}
		a.usd += b.ValueUSD
		if b.Amount != "" && b.Amount != "0" {
			a.anyAmount = true
		}
	}
	return resp.NextOffset, nil
}

// duneVerifiedCount applies the shared threshold per chain: summed
// USD above $1, or a non-zero amount when the chain carries no
// pricing at all.
func duneVerifiedCount(agg map[string]*duneChainAgg) int {
	n := 0
	for _, a := range agg {
		if a.anyPrice {
			if a.usd > verifiedUsdThreshold {
				n++
			}
			continue
		}
		if a.anyAmount {
			n++
		}
	}
	return n
}
