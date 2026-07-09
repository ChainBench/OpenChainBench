package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"
)

const (
	solanaChain        = "solana"
	stakewizSourceTag  = "stakewiz"
	jitoSourceTag      = "jito_kobe"
	coingeckoSourceTag = "coingecko"
)

// stakewizValidator mirrors the subset of fields we use from
// api.stakewiz.com/validators. Stakewiz returns ~2000 entries; the API
// response is a flat JSON array.
//
// IMPORTANT shape gotchas (verified against the live endpoint):
//   - The APY fields are expressed as **percentages**, not decimals.
//     total_apy=5.93 means 5.93% — to bps it's *100, NOT *10000.
//   - `activated_stake` is in **SOL units already** (138185 = 138k SOL).
//     The "lamports" hint in older Stakewiz docs is wrong on the
//     current /validators endpoint.
//   - `uptime` is a percentage in [0,100], not a 0-1 fraction.
//   - `commission` is an integer percentage (0..100).
//   - `skip_rate` IS a 0-1 fraction (yes, inconsistent with uptime).
type stakewizValidator struct {
	VoteIdentity   string  `json:"vote_identity"`
	Name           string  `json:"name"`
	TotalAPY       float64 `json:"total_apy"`        // percent total (e.g. 5.93 = 5.93%)
	APYEstimate    float64 `json:"apy_estimate"`     // percent, used as fallback
	StakingAPY     float64 `json:"staking_apy"`      // percent base staking
	JitoAPY        float64 `json:"jito_apy"`         // percent MEV/Jito share
	Commission     float64 `json:"commission"`       // percent integer (e.g. 7 = 7%)
	Uptime         float64 `json:"uptime"`           // percent in [0,100]
	SkipRate       float64 `json:"skip_rate"`        // 0-1 fraction
	Delinquent     bool    `json:"delinquent"`
	IsJito         bool    `json:"is_jito"`
	ActivatedStake float64 `json:"activated_stake"`  // in SOL units (not lamports)
}

// jitoKobeValidator mirrors kobe.mainnet.jito.network. Used purely as
// an enrichment source — its mev_commission_bps is the canonical answer
// when Stakewiz reports jito_apy=0 but the validator actually runs Jito.
type jitoKobeValidator struct {
	VoteAccount       string  `json:"vote_account"`
	MEVCommissionBps  float64 `json:"mev_commission_bps"`
	MEVRewards        float64 `json:"mev_rewards"`
	PriorityFeeRewards float64 `json:"priority_fee_rewards"`
	ActiveStake       float64 `json:"active_stake"`
	RunningJitoSolana bool    `json:"running_jito_2_0"`
}

// fetchSolanaPrice hits CoinGecko's free simple/price endpoint. No key,
// rate-limited to ~30 req/min — we use 1 call per 5-min cycle so we're
// nowhere near the ceiling.
func fetchSolanaPrice(ctx context.Context, client *http.Client) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, coingeckoURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("coingecko http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var payload map[string]map[string]float64
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, fmt.Errorf("coingecko parse: %w", err)
	}
	v, ok := payload["solana"]
	if !ok {
		return 0, fmt.Errorf("coingecko missing solana key")
	}
	price := v["usd"]
	if price <= 0 {
		return 0, fmt.Errorf("coingecko invalid price %f", price)
	}
	return price, nil
}

func fetchStakewiz(ctx context.Context, client *http.Client) ([]stakewizValidator, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, stakewizURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("stakewiz http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var out []stakewizValidator
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("stakewiz parse: %w", err)
	}
	return out, nil
}

func fetchJitoKobe(ctx context.Context, client *http.Client) (map[string]jitoKobeValidator, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, jitoKobeURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jito kobe http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	// Kobe returns `{"validators": [...]}`, not a bare array.
	var wrapper struct {
		Validators []jitoKobeValidator `json:"validators"`
	}
	if err := json.Unmarshal(body, &wrapper); err != nil {
		return nil, fmt.Errorf("jito kobe parse: %w", err)
	}
	idx := make(map[string]jitoKobeValidator, len(wrapper.Validators))
	for _, v := range wrapper.Validators {
		idx[v.VoteAccount] = v
	}
	return idx, nil
}

// scrapeSolana is the top-level scraper for the Solana chain. It pulls
// Stakewiz, enriches MEV data from Jito Kobe (best-effort — if Kobe
// fails we still publish Stakewiz numbers), and converts stake to USD
// via CoinGecko.
//
// Cap: top solanaTopN by activated_stake to keep cardinality bounded.
func scrapeSolana(ctx context.Context, client *http.Client) {
	validators, err := fetchStakewiz(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(solanaChain, stakewizSourceTag).Inc()
		fmt.Printf("[solana] stakewiz err: %v\n", err)
		return
	}

	jito, err := fetchJitoKobe(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(solanaChain, jitoSourceTag).Inc()
		fmt.Printf("[solana] jito kobe err (non-fatal, continuing with Stakewiz only): %v\n", err)
		jito = map[string]jitoKobeValidator{}
	}

	solPrice, err := fetchSolanaPrice(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(solanaChain, coingeckoSourceTag).Inc()
		fmt.Printf("[solana] coingecko err (stake_usd will be 0): %v\n", err)
		solPrice = 0
	}

	// Sort descending by activated stake and truncate to top N.
	sort.Slice(validators, func(i, j int) bool {
		return validators[i].ActivatedStake > validators[j].ActivatedStake
	})
	if len(validators) > solanaTopN {
		validators = validators[:solanaTopN]
	}

	// Note: we do NOT call .Reset() here because the gauges are
	// shared with the Hyperliquid scraper. Resetting would clobber
	// HL series. The top-N validators on Solana shift only by epoch
	// (~2 days), so stale series for dropped validators age out
	// naturally on the next deploy / restart. For MVP that's fine.

	netYields := make([]float64, 0, len(validators))
	for _, v := range validators {
		name := shortenName(v.Name)
		voteID := v.VoteIdentity

		// Gross APY — prefer total_apy (includes Jito), fall back to
		// apy_estimate, then staking_apy + jito_apy. All Stakewiz APY
		// fields are **percentages already** (5.93 = 5.93%) so to bps
		// it's *100, not *10000.
		grossPct := v.TotalAPY
		if grossPct == 0 {
			grossPct = v.APYEstimate
		}
		if grossPct == 0 {
			grossPct = v.StakingAPY + v.JitoAPY
		}
		grossBps := grossPct * 100

		// MEV share — Stakewiz jito_apy is the canonical answer when
		// non-zero. Fall back to Kobe enrichment for Jito-running
		// validators that Stakewiz hasn't tagged yet.
		mevPct := v.JitoAPY
		if mevPct == 0 {
			if k, ok := jito[voteID]; ok && k.MEVRewards > 0 && k.ActiveStake > 0 {
				// Rough APR contribution: per-epoch MEV / stake.
				// Stakewiz folds this into total_apy already; this
				// branch only runs when Stakewiz dropped the field.
				mevPct = (k.MEVRewards / k.ActiveStake) * 100
			}
		}
		mevBps := mevPct * 100

		// Commission is a percent integer in Stakewiz (0..100).
		commissionBps := v.Commission * 100

		// Uptime: Stakewiz `uptime` is already a percentage in [0,100].
		// Fall back to (1 - skip_rate)*100 when uptime is missing.
		uptimePct := v.Uptime
		if uptimePct == 0 && v.SkipRate > 0 {
			uptimePct = (1.0 - v.SkipRate) * 100
		}
		if uptimePct <= 0 && v.SkipRate == 0 {
			// Both missing — assume fully up rather than zero out
			// (zero would discard the validator from medians).
			uptimePct = 100
		}
		if uptimePct < 0 {
			uptimePct = 0
		}
		if uptimePct > 100 {
			uptimePct = 100
		}

		// Net yield = gross × uptime. Delinquent validators get
		// 0 net (they pay no rewards while delinquent).
		downtimeFactor := uptimePct / 100
		netBps := grossBps * downtimeFactor
		if v.Delinquent {
			netBps = 0
		}

		// `activated_stake` is already in SOL units on the current
		// Stakewiz endpoint (not lamports).
		stakeUSD := v.ActivatedStake * solPrice

		jailed := 0.0
		if v.Delinquent {
			jailed = 1
		}

		validatorNetYieldBps.WithLabelValues(solanaChain, voteID, name).Set(netBps)
		validatorGrossYieldBps.WithLabelValues(solanaChain, voteID, name).Set(grossBps)
		validatorMevShareBps.WithLabelValues(solanaChain, voteID, name).Set(mevBps)
		validatorCommissionBps.WithLabelValues(solanaChain, voteID, name).Set(commissionBps)
		validatorUptimePct.WithLabelValues(solanaChain, voteID, name).Set(uptimePct)
		// Publish-then-leave: on a CoinGecko failure solPrice is 0 and
		// writing stake*0 would wipe the previous good USD value for
		// every validator. Skip the write; the error counter above and
		// the stale sample age tell the degradation story.
		if solPrice > 0 {
			validatorStakeUSD.WithLabelValues(solanaChain, voteID, name).Set(stakeUSD)
		}
		validatorJailed.WithLabelValues(solanaChain, voteID, name).Set(jailed)

		netYields = append(netYields, netBps)
	}

	chainTotalValidators.WithLabelValues(solanaChain).Set(float64(len(validators)))
	chainMedianNetYieldBps.WithLabelValues(solanaChain).Set(medianBps(netYields))
	lastScrapeTimestamp.WithLabelValues(solanaChain).Set(float64(time.Now().Unix()))

	fmt.Printf("[solana] published %d validators, median net yield %.0f bps, SOL=$%.2f\n",
		len(validators), medianBps(netYields), solPrice)
}
