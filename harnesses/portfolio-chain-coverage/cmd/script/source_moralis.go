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
//	listed   = candidate chains the net-worth endpoint accepted this
//	           cycle, plus Solana when its separate gateway probe
//	           answers. One call PER CHAIN: a multi-chain call fails
//	           whole with "Wallet has too many ERC20 token balances
//	           for <chain>" on the Binance 8 whale wallet (observed
//	           on 0x38), which would collapse the entire EVM probe.
//	verified = accepted chains whose networth_usd clears the shared
//	           threshold. When net-worth refuses the wallet's token
//	           count on a chain, the chain is still acknowledged by
//	           the vendor, so the probe falls back to the native
//	           balance endpoint for that chain (no USD pricing there,
//	           so the shared native-amount rule applies). Solana
//	           verifies on a native amount above 0 for the same
//	           reason.
//
// The candidate list mirrors docs.moralis.com/supported-chains (EVM
// mainnets, checked 2026-07). Override without a rebuild via
// MORALIS_CHAINS (comma-separated hex chain ids); a candidate Moralis
// rejects with a 4xx is an expected answer (not listed, not an error
// bucket), so list drift is self-healing.
const (
	moralisBaseDefault    = "https://deep-index.moralis.io"
	moralisSolBaseDefault = "https://solana-gateway.moralis.io"
)

// moralisChainSpacing is the pause between per-chain net-worth calls
// so ~18 quick GETs do not read as a burst client to Moralis's edge.
const moralisChainSpacing = 1 * time.Second

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

	// --- EVM: one net-worth call per candidate chain ----------------
	listed, verified := -1, -1
	for i, c := range chains {
		if i > 0 {
			time.Sleep(moralisChainSpacing)
		}
		accepted, ok, el := probeMoralisChain(base, hdr, c)
		total += el
		if !accepted {
			continue
		}
		if listed < 0 {
			listed, verified = 0, 0
		}
		listed++
		if ok {
			verified++
		}
	}

	// --- Solana: separate gateway, best-effort ----------------------
	// Same tolerance as Mobula's optional wallets: a 4xx means the
	// key's plan does not include the Solana gateway, which is an
	// expected answer, not a fault.
	solURL := fmt.Sprintf("%s/account/mainnet/%s/portfolio", solBase, solTestAddress)
	raw, el, err := doCall("GET", solURL, hdr, nil)
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
			listed, verified = 0, 0
		}
		listed++
		if ok {
			verified++
		}
	}

	cov.listed = listed
	cov.verified = verified
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// probeMoralisChain measures one candidate chain. Returns whether the
// vendor acknowledged the chain (listed), whether a real balance was
// observed (verified), and the elapsed HTTP time.
func probeMoralisChain(base string, hdr map[string]string, chain string) (accepted, verifiedOK bool, total time.Duration) {
	q := url.Values{}
	q.Set("chains[0]", chain)
	q.Set("exclude_spam", "true")
	q.Set("exclude_unverified_contracts", "true")
	u := fmt.Sprintf("%s/api/v2.2/wallets/%s/net-worth?%s", base, evmTestAddress, q.Encode())
	raw, el, err := doCall("GET", u, hdr, nil)
	total += el

	if err == nil {
		l, v, perr := parseMoralisNetWorth(raw)
		if perr != nil {
			recordError("moralis", perr)
			fmt.Printf("[moralis] net-worth parse failed for %s: %v\n", chain, perr)
			return false, false, total
		}
		return l > 0, v > 0, total
	}

	status := httpStatus(err)
	if status == 400 && strings.Contains(strings.ToLower(err.Error()), "too many") {
		// The vendor knows the wallet's token count on this chain, so
		// the chain is acknowledged; net worth is just refused for
		// whale wallets. Fall back to the native balance endpoint
		// (no USD pricing there, shared native-amount rule applies).
		u2 := fmt.Sprintf("%s/api/v2.2/%s/balance?chain=%s", base, evmTestAddress, url.QueryEscape(chain))
		raw2, el2, err2 := doCall("GET", u2, hdr, nil)
		total += el2
		if err2 != nil {
			recordError("moralis", err2)
			fmt.Printf("[moralis] native balance fallback failed for %s: %v\n", chain, err2)
			return true, false, total
		}
		ok, perr := parseMoralisNativeBalance(raw2)
		if perr != nil {
			recordError("moralis", perr)
			fmt.Printf("[moralis] native balance parse failed for %s: %v\n", chain, perr)
			return true, false, total
		}
		return true, ok, total
	}
	if status >= 400 && status < 500 {
		// Candidate not supported (anymore): expected answer, not a
		// provider fault. Keeps the error counter honest when the
		// documented chain list drifts.
		fmt.Printf("[moralis] chain %s rejected (http %d), skipping\n", chain, status)
		return false, false, total
	}
	recordError("moralis", err)
	fmt.Printf("[moralis] net-worth probe failed for %s: %v\n", chain, err)
	return false, false, total
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

// parseMoralisNativeBalance reads the wei string from the native
// balance endpoint. Any positive amount verifies the chain (no USD
// pricing in this response, shared fallback rule).
func parseMoralisNativeBalance(raw []byte) (bool, error) {
	var resp struct {
		Balance string `json:"balance"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return false, fmt.Errorf("parse native balance: %w", err)
	}
	if resp.Balance == "" {
		return false, fmt.Errorf("parse native balance: no balance field: %s", truncate(string(raw), 120))
	}
	return resp.Balance != "0", nil
}

// parseMoralisSolPortfolio reports whether the Solana portfolio holds
// anything. The response carries no USD pricing, so the shared
// fallback applies: a native amount above 0 verifies the chain.
func parseMoralisSolPortfolio(raw []byte) (bool, error) {
	var r struct {
		NativeBalance struct {
			Solana string `json:"solana"`
		} `json:"nativeBalance"`
		Tokens []struct {
			Amount string `json:"amount"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return false, fmt.Errorf("parse solana portfolio: %w", err)
	}
	if amt, err := strconv.ParseFloat(r.NativeBalance.Solana, 64); err == nil && amt > 0 {
		return true, nil
	}
	for _, t := range r.Tokens {
		if amt, err := strconv.ParseFloat(t.Amount, 64); err == nil && amt > 0 {
			return true, nil
		}
	}
	return false, nil
}
