package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Moralis deep-index v2.2. Auth is the raw key in the X-API-Key
// header.
//
// Moralis exposes NO standalone machine-readable chain-catalog
// endpoint and every wallet call takes an explicit chains list, so
// listed carries listed_source="probe" (same convention as Zapper):
//
//	listed   = chains the net-worth endpoint accepted this cycle out
//	           of the candidate list below (accepted = echoed back in
//	           the response chains array; rejected candidates land in
//	           unsupported_chain_ids / unavailable_chains instead),
//	           plus Solana when its separate gateway probe answers.
//	verified = accepted chains whose networth_usd clears the shared
//	           threshold, plus Solana on a native amount above 0 (the
//	           Solana portfolio response carries no USD pricing).
//
// The candidate list mirrors docs.moralis.com/supported-chains (EVM
// mainnets, checked 2026-07). Override without a rebuild via
// MORALIS_CHAINS (comma-separated hex chain ids); drift is
// self-healing because a chain Moralis drops just stops being echoed
// back.
const (
	moralisBaseDefault    = "https://deep-index.moralis.io"
	moralisSolBaseDefault = "https://solana-gateway.moralis.io"
)

var moralisDefaultChains = []string{
	"0x1",     // ethereum
	"0x89",    // polygon
	"0x38",    // bsc
	"0xa4b1",  // arbitrum
	"0x2105",  // base
	"0xa",     // optimism
	"0xe708",  // linea
	"0xa86a",  // avalanche
	"0x19",    // cronos
	"0x64",    // gnosis
	"0x15b38", // chiliz
	"0x504",   // moonbeam
	"0x2eb",   // flow evm
	"0x7e4",   // ronin
	"0x46f",   // lisk
	"0x171",   // pulsechain
	"0x531",   // sei evm
	"0x8f",    // monad
}

func probeMoralis(key string) coverage {
	base := envDefault("MORALIS_BASE_URL", moralisBaseDefault)
	solBase := envDefault("MORALIS_SOL_BASE_URL", moralisSolBaseDefault)
	hdr := map[string]string{"X-API-Key": key, "Accept": "application/json"}
	cov := coverage{listed: -1, listedSource: "probe", verified: -1}
	var total time.Duration

	chains := moralisDefaultChains
	if v := envDefault("MORALIS_CHAINS", ""); v != "" {
		chains = nil
		for _, c := range strings.Split(v, ",") {
			if c = strings.TrimSpace(c); c != "" {
				chains = append(chains, c)
			}
		}
	}

	// --- EVM: one net-worth call across the candidate list ---------
	q := url.Values{}
	for i, c := range chains {
		q.Set(fmt.Sprintf("chains[%d]", i), c)
	}
	q.Set("exclude_spam", "true")
	q.Set("exclude_unverified_contracts", "true")
	u := fmt.Sprintf("%s/api/v2.2/wallets/%s/net-worth?%s", base, evmTestAddress, q.Encode())
	raw, el, err := doCall("GET", u, hdr, nil)
	total += el
	listed, verified := -1, -1
	if err != nil {
		recordError("moralis", err)
		fmt.Printf("[moralis] net-worth probe failed: %v\n", err)
	} else if l, v, perr := parseMoralisNetWorth(raw); perr != nil {
		recordError("moralis", perr)
		fmt.Printf("[moralis] net-worth parse failed: %v\n", perr)
	} else {
		listed, verified = l, v
	}

	// --- Solana: separate gateway, best-effort ----------------------
	// Same tolerance as Mobula's optional wallets: a 4xx means the
	// key's plan does not include the Solana gateway, which is an
	// expected answer, not a fault.
	solURL := fmt.Sprintf("%s/account/mainnet/%s/portfolio", solBase, solTestAddress)
	raw, el, err = doCall("GET", solURL, hdr, nil)
	total += el
	if err != nil {
		if status := httpStatus(err); status >= 400 && status < 500 {
			fmt.Printf("[moralis] optional solana portfolio not available (http %d), skipping\n", status)
		} else {
			recordError("moralis", err)
			fmt.Printf("[moralis] solana portfolio probe failed: %v\n", err)
		}
	} else if ok, perr := parseMoralisSolPortfolio(raw); perr != nil {
		recordError("moralis", perr)
		fmt.Printf("[moralis] solana portfolio parse failed: %v\n", perr)
	} else {
		if listed < 0 {
			listed = 0
		}
		listed++
		if ok {
			if verified < 0 {
				verified = 0
			}
			verified++
		}
	}

	cov.listed = listed
	cov.verified = verified
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// parseMoralisNetWorth returns (accepted chain count, chains whose
// networth_usd clears the shared threshold). Values are USD strings
// by contract, so no native fallback applies here.
func parseMoralisNetWorth(raw []byte) (int, int, error) {
	var resp struct {
		Chains []struct {
			Chain       string `json:"chain"`
			NetworthUSD string `json:"networth_usd"`
		} `json:"chains"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return 0, 0, fmt.Errorf("parse net-worth: %w", err)
	}
	if resp.Chains == nil {
		return 0, 0, fmt.Errorf("parse net-worth: no chains array: %s", truncate(string(raw), 120))
	}
	seen := map[string]bool{}
	listed, verified := 0, 0
	for _, c := range resp.Chains {
		if c.Chain == "" || seen[c.Chain] {
			continue
		}
		seen[c.Chain] = true
		listed++
		if usd, perr := strconv.ParseFloat(c.NetworthUSD, 64); perr == nil && usd > verifiedUsdThreshold {
			verified++
		}
	}
	return listed, verified, nil
}

// parseMoralisSolPortfolio reports whether the Solana portfolio holds
// anything. The response carries no USD pricing, so the shared
// fallback applies: a native amount above 0 verifies the chain.
func parseMoralisSolPortfolio(raw []byte) (bool, error) {
	var resp struct {
		NativeBalance struct {
			Solana string `json:"solana"`
		} `json:"nativeBalance"`
		Tokens []struct {
			Amount string `json:"amount"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return false, fmt.Errorf("parse solana portfolio: %w", err)
	}
	if amt, err := strconv.ParseFloat(resp.NativeBalance.Solana, 64); err == nil && amt > 0 {
		return true, nil
	}
	for _, t := range resp.Tokens {
		if amt, err := strconv.ParseFloat(t.Amount, 64); err == nil && amt > 0 {
			return true, nil
		}
	}
	return false, nil
}
