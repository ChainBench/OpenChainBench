package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// Mobula v1. Auth is the raw key in the Authorization header.
//
// listed:   GET /api/1/blockchains — catalog of supported chains. The
//           response shape is tolerated both as {data:[...]} and as a
//           bare top-level array.
// verified: GET /api/1/wallet/portfolio?wallet=<EVM>&fetchAllChains=
//           true — distinct chain keys inside
//           data.assets[].cross_chain_balances with value > $1.
//           The SOL and BTC test addresses are attempted through the
//           same endpoint once each; a 4xx there means the wallet
//           type is unsupported and is tolerated silently (no retry,
//           no error bucket — it is an expected answer, not a fault).
const mobulaBaseDefault = "https://api.mobula.io"

func probeMobula(key string) coverage {
	base := envDefault("MOBULA_BASE_URL", mobulaBaseDefault)
	hdr := map[string]string{"Authorization": key, "Accept": "application/json"}
	cov := coverage{listed: -1, listedSource: "declared", verified: -1, probed: -1}
	var total time.Duration

	// --- listed: self-declared chain catalog -----------------------
	raw, el, err := doCall("mobula", "GET", base+"/api/1/blockchains", hdr, nil)
	total += el
	if err != nil {
		recordError("mobula", err)
		fmt.Printf("[mobula] blockchains catalog failed: %v\n", err)
	} else if n, perr := parseMobulaBlockchains(raw); perr != nil {
		recordError("mobula", perr)
		fmt.Printf("[mobula] blockchains parse failed: %v\n", perr)
	} else {
		cov.listed = n
	}

	// --- verified: portfolio probes ---------------------------------
	verified := map[string]bool{}
	// probed = verified chains + funded non-EVM wallets that answered
	// but contributed no new chain (probed-but-failed). The EVM sweep
	// itself only counts chains it verified (funding elsewhere is
	// unknowable from one address).
	probedMisses := 0
	anyProbeOK := false

	// EVM sweep first, then the shared non-EVM probe set (identical
	// addresses to every other provider, see addresses.go). Non-EVM
	// wallets are best-effort: Mobula's endpoint takes raw addresses,
	// so a 4xx just means it does not index that wallet type.
	wallets := append([]string{evmTestAddress}, uniqueProbeAddresses()...)
	for i, wallet := range wallets {
		optional := i > 0 // non-EVM support is best-effort
		if i > 0 {
			time.Sleep(sweepSpacing)
		}
		url := fmt.Sprintf("%s/api/1/wallet/portfolio?wallet=%s&fetchAllChains=true", base, wallet)
		raw, el, err := doCall("mobula", "GET", url, hdr, nil)
		total += el
		if err != nil {
			status := httpStatus(err)
			if optional && status >= 400 && status < 500 {
				// Expected when the endpoint does not index this
				// wallet type; not a provider fault.
				fmt.Printf("[mobula] optional wallet %s not supported (http %d), skipping\n", wallet, status)
				continue
			}
			recordError("mobula", err)
			fmt.Printf("[mobula] portfolio probe failed for %s: %v\n", wallet, err)
			continue
		}
		chains, perr := parseMobulaPortfolio(raw)
		if perr != nil {
			recordError("mobula", perr)
			fmt.Printf("[mobula] portfolio parse failed for %s: %v\n", wallet, perr)
			continue
		}
		before := len(verified)
		for _, c := range chains {
			verified[c] = true
		}
		if optional && len(verified) == before {
			// Funded wallet answered with nothing new: the chain it
			// holds a real balance on is not indexed here.
			probedMisses++
		}
		anyProbeOK = true
	}

	if anyProbeOK {
		cov.verified = len(verified)
		cov.probed = len(verified) + probedMisses
	}
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// parseMobulaBlockchains counts catalog entries, tolerating both
// {data:[...]} and a bare top-level array.
func parseMobulaBlockchains(raw []byte) (int, error) {
	var wrapped struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &wrapped); err == nil && wrapped.Data != nil {
		return len(wrapped.Data), nil
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil {
		return len(arr), nil
	}
	return 0, fmt.Errorf("parse blockchains: unexpected shape: %s", truncate(string(raw), 120))
}

// parseMobulaPortfolio returns the distinct chain keys inside
// data.assets[].cross_chain_balances whose value clears the shared
// threshold. Per-chain USD is taken from balanceUSD when present,
// otherwise reconstructed as balance * asset price; when no pricing
// exists at all, native amount > 0 counts (same fallback as the
// other providers).
func parseMobulaPortfolio(raw []byte) ([]string, error) {
	var resp struct {
		Data struct {
			Assets []struct {
				Price              float64 `json:"price"`
				CrossChainBalances map[string]struct {
					Balance    float64 `json:"balance"`
					BalanceUSD float64 `json:"balanceUSD"`
				} `json:"cross_chain_balances"`
			} `json:"assets"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("parse portfolio: %w", err)
	}

	set := map[string]bool{}
	for _, asset := range resp.Data.Assets {
		for chain, bal := range asset.CrossChainBalances {
			if chain == "" || set[chain] {
				continue
			}
			usd := bal.BalanceUSD
			if usd == 0 && asset.Price > 0 {
				usd = bal.Balance * asset.Price
			}
			if usd > verifiedUsdThreshold {
				set[chain] = true
				continue
			}
			// No pricing anywhere: fall back to native amount.
			if asset.Price == 0 && bal.BalanceUSD == 0 && bal.Balance > 0 {
				set[chain] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	return out, nil
}
