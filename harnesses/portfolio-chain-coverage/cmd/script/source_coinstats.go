package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// CoinStats openapiv1. Auth is the raw key in the X-API-KEY header.
//
// listed:   GET /wallet/blockchains — machine-readable catalog; one
//           row per supported connection, identified by connectionId.
// verified: 3 calls per cycle —
//           GET /wallet/balances?address=<EVM>&networks=all covers
//           every EVM chain in one shot (response is an array of
//           {blockchain, balances[]} groups), plus one
//           GET /wallet/balance?...&connectionId=solana and one
//           ...&connectionId=bitcoin for the non-EVM chains.
const coinstatsBaseDefault = "https://openapiv1.coinstats.app"

func probeCoinStats(key string) coverage {
	base := envDefault("COINSTATS_BASE_URL", coinstatsBaseDefault)
	hdr := map[string]string{"X-API-KEY": key, "Accept": "application/json"}
	cov := coverage{listed: -1, listedSource: "declared", verified: -1}
	var total time.Duration

	// --- listed: self-declared chain catalog -----------------------
	raw, el, err := doCall("coinstats", "GET", base+"/wallet/blockchains", hdr, nil)
	total += el
	if err != nil {
		recordError("coinstats", err)
		fmt.Printf("[coinstats] blockchains catalog failed: %v\n", err)
	} else if n, perr := parseCoinStatsBlockchains(raw); perr != nil {
		recordError("coinstats", perr)
		fmt.Printf("[coinstats] blockchains parse failed: %v\n", perr)
	} else {
		cov.listed = n
	}

	// --- verified: balance probes -----------------------------------
	verified := map[string]bool{}
	anyProbeOK := false

	// All EVM chains in one call.
	url := fmt.Sprintf("%s/wallet/balances?address=%s&networks=all", base, evmTestAddress)
	raw, el, err = doCall("coinstats", "GET", url, hdr, nil)
	total += el
	if err != nil {
		recordError("coinstats", err)
		fmt.Printf("[coinstats] EVM balances probe failed: %v\n", err)
	} else if chains, perr := parseCoinStatsMultiBalances(raw); perr != nil {
		recordError("coinstats", perr)
		fmt.Printf("[coinstats] EVM balances parse failed: %v\n", perr)
	} else {
		for _, c := range chains {
			verified[c] = true
		}
		anyProbeOK = true
	}

	// Non-EVM: one call per connectionId over the shared probe set
	// (see addresses.go), spaced so ~60 quick GETs never read as a
	// burst. A 4xx on one chain is an expected answer (connectionId
	// dropped from the catalog, address format rejected), not a
	// provider fault, so it is logged but never error-bucketed.
	for _, probe := range chainProbes {
		time.Sleep(sweepSpacing)
		url := fmt.Sprintf("%s/wallet/balance?address=%s&connectionId=%s", base, probe.addr, probe.connectionID)
		raw, el, err := doCall("coinstats", "GET", url, hdr, nil)
		total += el
		if err != nil {
			if status := httpStatus(err); status >= 400 && status < 500 {
				fmt.Printf("[coinstats] %s probe rejected (http %d), skipping\n", probe.connectionID, status)
				anyProbeOK = true
				continue
			}
			recordError("coinstats", err)
			fmt.Printf("[coinstats] %s balance probe failed: %v\n", probe.connectionID, err)
			continue
		}
		ok, perr := parseCoinStatsSingleBalance(raw)
		if perr != nil {
			recordError("coinstats", perr)
			fmt.Printf("[coinstats] %s balance parse failed: %v\n", probe.connectionID, perr)
			continue
		}
		if ok {
			verified[probe.connectionID] = true
		}
		anyProbeOK = true
	}

	if anyProbeOK {
		cov.verified = len(verified)
	}
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// coinStatsBalanceRow is one coin balance row. CoinStats does not
// document whether `price` is always present, so USD valuation falls
// back to native-amount-only semantics when it is absent.
type coinStatsBalanceRow struct {
	CoinID string  `json:"coinId"`
	Amount float64 `json:"amount"`
	Price  float64 `json:"price"`
}

// usd returns the row's USD value, or 0 when no price is present.
func (r coinStatsBalanceRow) usd() float64 { return r.Amount * r.Price }

// parseCoinStatsBlockchains counts catalog rows carrying a non-empty
// connectionId (the vendor's stable chain identifier).
func parseCoinStatsBlockchains(raw []byte) (int, error) {
	var rows []struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return 0, fmt.Errorf("parse blockchains: %w", err)
	}
	n := 0
	for _, r := range rows {
		if r.ConnectionID != "" {
			n++
		}
	}
	return n, nil
}

// parseCoinStatsMultiBalances handles the networks=all response: an
// array of {blockchain, balances[]} groups. A chain is verified when
// its summed USD value is > $1, or when the response carries no
// prices at all for that chain and some native amount is > 0.
func parseCoinStatsMultiBalances(raw []byte) ([]string, error) {
	var groups []struct {
		Blockchain string                `json:"blockchain"`
		Balances   []coinStatsBalanceRow `json:"balances"`
	}
	if err := json.Unmarshal(raw, &groups); err != nil {
		return nil, fmt.Errorf("parse multi balances: %w", err)
	}
	var out []string
	for _, g := range groups {
		if g.Blockchain == "" {
			continue
		}
		if balancesVerified(g.Balances) {
			out = append(out, g.Blockchain)
		}
	}
	return out, nil
}

// parseCoinStatsSingleBalance handles the single-connectionId
// response: a flat array of balance rows for one chain.
func parseCoinStatsSingleBalance(raw []byte) (bool, error) {
	var rows []coinStatsBalanceRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		return false, fmt.Errorf("parse single balance: %w", err)
	}
	return balancesVerified(rows), nil
}

// balancesVerified applies the shared threshold: total USD > $1, or
// native amount > 0 when no USD pricing is present at all.
func balancesVerified(rows []coinStatsBalanceRow) bool {
	totalUsd := 0.0
	anyPrice := false
	anyAmount := false
	for _, r := range rows {
		if r.Price > 0 {
			anyPrice = true
		}
		if r.Amount > 0 {
			anyAmount = true
		}
		totalUsd += r.usd()
	}
	if anyPrice {
		return totalUsd > verifiedUsdThreshold
	}
	return anyAmount
}
