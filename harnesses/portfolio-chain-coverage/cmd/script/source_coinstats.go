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
	cov := coverage{listed: -1, listedSource: "declared", verified: -1, probed: -1}
	var total time.Duration
	quotaHit := false

	// --- listed: self-declared chain catalog -----------------------
	raw, el, err := doCall("coinstats", "GET", base+"/wallet/blockchains", hdr, nil)
	total += el
	chainOf := map[string]string{}
	if err != nil {
		quotaHit = quotaHit || isQuotaStatus(httpStatus(err))
		recordError("coinstats", err)
		fmt.Printf("[coinstats] blockchains catalog failed: %v\n", err)
	} else if n, m, perr := parseCoinStatsBlockchains(raw); perr != nil {
		recordError("coinstats", perr)
		fmt.Printf("[coinstats] blockchains parse failed: %v\n", perr)
	} else {
		cov.listed = n
		chainOf = m
	}

	// --- verified: balance probes -----------------------------------
	// Two key namespaces are in play: the EVM sweep returns catalog
	// chain keys (arbitrum-one, binance_smart, ...) while per-chain
	// probes are keyed by connectionId (arbitrum-wallet, ...). The
	// catalog's connectionId -> chain map bridges them so a chain
	// verified by both paths never counts twice. connectionIds that
	// share a chain key (terra-wallet / terra-wallet-2) stay distinct:
	// they are different networks.
	verifiedSweep := map[string]bool{}  // catalog chain keys
	verifiedProbe := map[string]bool{}  // connectionIds
	answeredProbe := map[string]bool{}  // connectionIds with a definitive reply
	anyProbeOK := false

	// All EVM chains in one call.
	url := fmt.Sprintf("%s/wallet/balances?address=%s&networks=all", base, evmTestAddress)
	raw, el, err = doCall("coinstats", "GET", url, hdr, nil)
	total += el
	if err != nil {
		quotaHit = quotaHit || isQuotaStatus(httpStatus(err))
		recordError("coinstats", err)
		fmt.Printf("[coinstats] EVM balances probe failed: %v\n", err)
	} else if chains, perr := parseCoinStatsMultiBalances(raw); perr != nil {
		recordError("coinstats", perr)
		fmt.Printf("[coinstats] EVM balances parse failed: %v\n", perr)
	} else {
		for _, c := range chains {
			verifiedSweep[c] = true
		}
		anyProbeOK = true
	}

	// Non-EVM: one call per connectionId over the shared probe set
	// (see addresses.go), spaced so ~60 quick GETs never read as a
	// burst. A 4xx on one chain is an expected answer (connectionId
	// dropped from the catalog, address format rejected), not a
	// provider fault, so it is logged but never error-bucketed.
	for _, probe := range chainProbes {
		if len(chainOf) > 0 {
			if _, inCatalog := chainOf[probe.connectionID]; !inCatalog {
				// The vendor does not list this chain: nothing to
				// test, no call to spend, no miss to debit.
				continue
			}
		}
		time.Sleep(sweepSpacing)
		url := fmt.Sprintf("%s/wallet/balance?address=%s&connectionId=%s", base, probe.addr, probe.connectionID)
		raw, el, err := doCall("coinstats", "GET", url, hdr, nil)
		total += el
		if err != nil {
			if status := httpStatus(err); status == 400 || status == 404 {
				// Deterministic per-chain refusal of a funded
				// address: probed-but-not-verified, an honest
				// indexer gap. ONLY 400/404 qualify — quota, auth
				// and throttle failures (401/402/403/406/429) say
				// nothing about the chain and must never turn into
				// a published zero (seen live: a 406 credit-limit
				// day published verified=0 and wiped the gauges).
				fmt.Printf("[coinstats] %s probe rejected (http %d), skipping\n", probe.connectionID, status)
				answeredProbe[probe.connectionID] = true
				continue
			}
			quotaHit = quotaHit || isQuotaStatus(httpStatus(err))
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
		answeredProbe[probe.connectionID] = true
		if ok {
			verifiedProbe[probe.connectionID] = true
		}
		anyProbeOK = true
	}

	if quotaHit {
		// Truncated by credits/auth/throttle: the counts are an
		// artifact of the outage, not a measurement. Publish nothing
		// and let publish-then-leave carry the previous cycle.
		fmt.Printf("[coinstats] quota-class failures during cycle, publishing nothing\n")
		cov.listed, cov.verified, cov.probed = -1, -1, -1
	} else if anyProbeOK {
		cov.verified = countDeduped(verifiedSweep, verifiedProbe, chainOf)
		cov.probed = countDeduped(verifiedSweep, answeredProbe, chainOf)
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
// connectionId (the vendor's stable chain identifier) and returns the
// connectionId -> chain-key map used to reconcile per-connectionId
// probes with the EVM sweep's chain keys.
func parseCoinStatsBlockchains(raw []byte) (int, map[string]string, error) {
	var rows []struct {
		ConnectionID string `json:"connectionId"`
		Chain        string `json:"chain"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return 0, nil, fmt.Errorf("parse blockchains: %w", err)
	}
	n := 0
	chainOf := map[string]string{}
	for _, r := range rows {
		if r.ConnectionID != "" {
			n++
			if r.Chain != "" {
				chainOf[r.ConnectionID] = r.Chain
			}
		}
	}
	return n, chainOf, nil
}

// countDeduped merges the EVM sweep (chain keys) with per-connectionId
// probe results: a probe only adds to the count when its chain key is
// not already covered by the sweep. Unknown connectionIds fall back to
// counting as-is (worst case: one duplicate during a catalog outage).
func countDeduped(sweep, probes map[string]bool, chainOf map[string]string) int {
	n := len(sweep)
	for cid := range probes {
		if ck, okc := chainOf[cid]; okc && sweep[ck] {
			continue
		}
		n++
	}
	return n
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
