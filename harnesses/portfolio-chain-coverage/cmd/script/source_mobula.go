package main

import (
	"encoding/json"
	"fmt"
	neturl "net/url"
	"strings"
	"time"
)

// Mobula v1. Auth is the raw key in the Authorization header.
//
// listed:   GET /api/1/blockchains — catalog of supported chains. The
//           response shape is tolerated both as {data:[...]} and as a
//           bare top-level array.
// verified: GET /api/1/wallet/portfolio with EXPLICIT blockchains=
//           targeting — distinct chain keys inside
//           data.assets[].cross_chain_balances with value > $1.
//           Explicit targeting is used because it is the vendor's
//           most precise documented invocation (mirroring the
//           per-chain probes every other vendor gets) and because
//           fetchAllChains=true was observed to silently skip ~25
//           catalog chains that the explicit path returns perfectly
//           (verified against on-chain RPCs, 2026-07-07). The main
//           sweep wallet targets the whole catalog minus testnets;
//           probe wallets target their own chains. fetchAllChains
//           remains the fallback when the catalog call failed.
//           4xx on a probe wallet means the wallet type is
//           unsupported and is tolerated silently (expected answer,
//           not a fault).
const mobulaBaseDefault = "https://api.mobula.io"

func probeMobula(key string) coverage {
	base := envDefault("MOBULA_BASE_URL", mobulaBaseDefault)
	hdr := map[string]string{"Authorization": key, "Accept": "application/json"}
	cov := coverage{listed: -1, listedSource: "declared", verified: -1, probed: -1}
	var total time.Duration

	// --- listed: self-declared chain catalog -----------------------
	raw, el, err := doCall("mobula", "GET", base+"/api/1/blockchains", hdr, nil)
	total += el
	catalog := map[string]bool{}
	var catalogRows []mobulaCatalogRow
	if err != nil {
		recordError("mobula", err)
		fmt.Printf("[mobula] blockchains catalog failed: %v\n", err)
	} else if n, rows, perr := parseMobulaBlockchains(raw); perr != nil {
		recordError("mobula", perr)
		fmt.Printf("[mobula] blockchains parse failed: %v\n", perr)
	} else {
		cov.listed = n
		catalogRows = rows
		for _, r := range rows {
			for _, v := range []string{r.Name, r.Chain} {
				if nn := normalizeChainName(v); nn != "" {
					catalog[nn] = true
				}
			}
		}
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
	namesByAddr := probeNamesByAddr()
	// Mainnet catalog names for explicit targeting. Testnets are
	// excluded: they are unverifiable with mainnet whale wallets and
	// must not inflate verified via priceless testnet gas balances.
	var mainnetNames []string
	normToRaw := map[string]string{}
	for _, r := range catalogRows {
		nn := normalizeChainName(r.Name)
		if nn == "" || strings.Contains(nn, "testnet") || strings.Contains(nn, "bartio") {
			continue
		}
		mainnetNames = append(mainnetNames, r.Name)
		normToRaw[nn] = r.Name
		if cn := normalizeChainName(r.Chain); cn != "" {
			normToRaw[cn] = r.Name
		}
	}
	fullCSV := neturl.QueryEscape(strings.Join(mainnetNames, ","))
	for i, wallet := range wallets {
		optional := i > 0 // non-EVM support is best-effort
		if i > 0 {
			time.Sleep(sweepSpacing)
		}
		// Explicit targeting: probe wallets ask for their own target
		// chains, the main sweep wallet asks for the whole mainnet
		// catalog. Fall back to fetchAllChains when the catalog call
		// failed this cycle.
		query := "fetchAllChains=true"
		if len(mainnetNames) > 0 {
			if i == 0 {
				query = "blockchains=" + fullCSV
			} else {
				seen := map[string]bool{}
				var targets []string
				for _, n := range namesByAddr[wallet] {
					if raw, ok := normToRaw[n]; ok && !seen[raw] {
						seen[raw] = true
						targets = append(targets, raw)
					}
				}
				if len(targets) > 0 {
					query = "blockchains=" + neturl.QueryEscape(strings.Join(targets, ","))
				}
			}
		}
		url := fmt.Sprintf("%s/api/1/wallet/portfolio?wallet=%s&%s", base, wallet, query)
		raw, el, err := doCall("mobula", "GET", url, hdr, nil)
		total += el
		if err != nil {
			status := httpStatus(err)
			if optional && (status == 400 || status == 404) {
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
		if optional && len(verified) == before &&
			anyNameInSet(catalog, namesByAddr[wallet]) {
			// Funded wallet answered with nothing new AND its target
			// chain is in the vendor's own catalog: a real indexer
			// gap. Misses on chains the vendor never listed do not
			// count (and when the catalog call failed, no miss is
			// counted at all — probed degrades to the verified
			// floor rather than guessing).
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

// mobulaCatalogRow is one catalog entry (raw names, used both for
// probe-miss intersection and for explicit blockchains= targeting).
type mobulaCatalogRow struct {
	Name  string `json:"name"`
	Chain string `json:"chain"`
}

// parseMobulaBlockchains counts catalog entries and returns the raw
// rows, tolerating both {data:[...]} and a bare top-level array.
func parseMobulaBlockchains(raw []byte) (int, []mobulaCatalogRow, error) {
	var wrapped struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &wrapped); err == nil && wrapped.Data != nil {
		return len(wrapped.Data), mobulaCatalogRows(wrapped.Data), nil
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil {
		return len(arr), mobulaCatalogRows(arr), nil
	}
	return 0, nil, fmt.Errorf("parse blockchains: unexpected shape: %s", truncate(string(raw), 120))
}

func mobulaCatalogRows(rows []json.RawMessage) []mobulaCatalogRow {
	out := make([]mobulaCatalogRow, 0, len(rows))
	for _, r := range rows {
		var row mobulaCatalogRow
		if json.Unmarshal(r, &row) != nil {
			continue
		}
		out = append(out, row)
	}
	return out
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
