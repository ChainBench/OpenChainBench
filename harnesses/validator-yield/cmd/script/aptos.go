package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Aptos. Source: the public Aptos fullnode REST API (no key).
//
// Reward rule (aptos-framework stake.move, distribute_rewards): each
// epoch a validator's stake grows by
//
//	stake × rewards_rate × successful_proposals / total_proposals
//
// so a perfectly-performing validator earns `rewards_rate` per epoch.
// The live rate is StakingRewardsConfig.rewards_rate (a FixedPoint64)
// whenever feature flag 16 (PERIODICAL_REWARD_RATE_DECREASE) is on,
// which it is on mainnet; otherwise the legacy StakingConfig
// rewards_rate / rewards_rate_denominator pair applies. We read both
// and pick per the flag. Epoch length comes from BlockResource
// epoch_interval (microseconds, 2 h on mainnet).
//
// Verified 2026-11-03: rewards_rate = 109501220528869 / 2^64 per
// epoch × 4383 epochs/year = 2.60% APR, matching the April 2026
// governance cut from 5.19% to 2.6%.
//
// Cohort: active validators that are delegation pools (the only ones
// a third party can stake with; the rest are private stake pools).
// Net = gross × performance × (1 − operator commission), where
// performance is this epoch's successful/(successful+failed) proposals
// from ValidatorPerformance. A validator with no proposal yet in the
// current epoch is published at 100% (no evidence either way).

const (
	aptosChain      = "aptos"
	aptosStateTag   = "aptos_resources"
	aptosCommTag    = "aptos_delegation_pool_view"
	aptosOctas      = 1e8
	aptosRateFlag   = "16"
	fixedPoint64Den = 18446744073709551616.0 // 2^64
)

var aptosAPI = envDefault("VAL_ECON_APTOS_URL", "https://api.mainnet.aptoslabs.com/v1")

type aptosResource[T any] struct {
	Data T `json:"data"`
}

type aptosStakingConfig struct {
	RewardsRate            string `json:"rewards_rate"`
	RewardsRateDenominator string `json:"rewards_rate_denominator"`
}

type aptosStakingRewardsConfig struct {
	RewardsRate struct {
		Value string `json:"value"`
	} `json:"rewards_rate"`
}

type aptosBlockResource struct {
	EpochInterval string `json:"epoch_interval"` // microseconds
}

type aptosValidatorSet struct {
	ActiveValidators []struct {
		Addr        string `json:"addr"`
		VotingPower string `json:"voting_power"`
		Config      struct {
			ValidatorIndex string `json:"validator_index"`
		} `json:"config"`
	} `json:"active_validators"`
}

type aptosPerformance struct {
	Validators []struct {
		Successful string `json:"successful_proposals"`
		Failed     string `json:"failed_proposals"`
	} `json:"validators"`
}

// aptosPerEpochRate picks the live per-epoch reward rate.
func aptosPerEpochRate(periodicalEnabled bool, fixedPointValue, legacyRate, legacyDenom string) (float64, error) {
	if periodicalEnabled {
		v, ok := new(big.Float).SetString(fixedPointValue)
		if !ok {
			return 0, fmt.Errorf("aptos: bad fixed point %q", fixedPointValue)
		}
		f, _ := v.Float64()
		return f / fixedPoint64Den, nil
	}
	r, d := parseFloat(legacyRate), parseFloat(legacyDenom)
	if d <= 0 {
		return 0, fmt.Errorf("aptos: zero rewards_rate_denominator")
	}
	return r / d, nil
}

// aptosNetBps returns (gross, net, uptimePct) for one validator.
func aptosNetBps(perEpochRate, epochSeconds float64, successful, failed int64, commissionBps float64) (float64, float64, float64) {
	gross := pctToBps(perEpochRate * secondsPerYear / epochSeconds)
	uptime := 100.0
	if total := successful + failed; total > 0 {
		uptime = 100 * float64(successful) / float64(total)
	}
	net := gross * (uptime / 100) * (1 - clamp(commissionBps, 0, 10000)/10000)
	return gross, net, uptime
}

func aptosView(ctx context.Context, client *http.Client, fn string, args []string, out any) error {
	return postJSON(ctx, client, aptosAPI+"/view", map[string]any{
		"function": fn, "type_arguments": []string{}, "arguments": args,
	}, out)
}

// jsonNum reads a Move view return value that may come back as a JSON
// string ("1000") or number.
func jsonNum(raw json.RawMessage) float64 {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return parseFloat(s)
	}
	var f float64
	_ = json.Unmarshal(raw, &f)
	return f
}

// The anonymous Aptos Labs API allows 40 000 compute units per IP per
// 5 minutes and every view call spends some, so the per-pool
// commission (which changes rarely) is cached for aptosCommTTL, a
// private stake pool is remembered as such, and at most
// aptosCommBudget lookups run per scrape (a cold start fills the 83
// validators over 3 cycles).
const (
	aptosCommTTL    = 6 * time.Hour
	aptosCommBudget = 30 // view calls per scrape at most
)

var aptosCommCache = struct {
	sync.Mutex
	at  map[string]time.Time
	bps map[string]float64 // -1 = not a delegation pool
}{at: map[string]time.Time{}, bps: map[string]float64{}}

// aptosCommission returns (commission bps, known delegation pool,
// fetched). Fresh cache → no call; otherwise one view call when
// mayFetch, falling back to the stale value on a 429 or timeout.
func aptosCommission(ctx context.Context, client *http.Client, addr string, mayFetch bool) (float64, bool, bool) {
	aptosCommCache.Lock()
	t, cached := aptosCommCache.at[addr]
	stale := aptosCommCache.bps[addr]
	aptosCommCache.Unlock()
	if cached && time.Since(t) < aptosCommTTL {
		return stale, stale >= 0, false
	}
	if !mayFetch {
		return stale, cached && stale >= 0, false
	}
	var comm []json.RawMessage
	err := aptosView(ctx, client, "0x1::delegation_pool::operator_commission_percentage", []string{addr}, &comm)
	bps := -1.0
	switch {
	case err == nil && len(comm) > 0:
		bps = jsonNum(comm[0]) // 2 decimals: 1000 = 10.00%
	case err != nil && strings.Contains(err.Error(), "EDELEGATION_POOL_DOES_NOT_EXIST"):
		// private stake pool: outside the cohort, cache that
	default:
		scrapeErrorsTotal.WithLabelValues(aptosChain, aptosCommTag).Inc()
		return stale, cached && stale >= 0, true
	}
	aptosCommCache.Lock()
	aptosCommCache.at[addr] = time.Now()
	aptosCommCache.bps[addr] = bps
	aptosCommCache.Unlock()
	return bps, bps >= 0, true
}

func scrapeAptos(ctx context.Context, client *http.Client) {
	fail := func(tag string, err error) {
		scrapeErrorsTotal.WithLabelValues(aptosChain, tag).Inc()
		fmt.Printf("[aptos] %s err: %v\n", tag, err)
	}
	res := aptosAPI + "/accounts/0x1/resource/"
	var legacy aptosResource[aptosStakingConfig]
	var periodical aptosResource[aptosStakingRewardsConfig]
	var blk aptosResource[aptosBlockResource]
	var set aptosResource[aptosValidatorSet]
	var perf aptosResource[aptosPerformance]
	for _, q := range []struct {
		path string
		out  any
	}{
		{"0x1::staking_config::StakingConfig", &legacy},
		{"0x1::staking_config::StakingRewardsConfig", &periodical},
		{"0x1::block::BlockResource", &blk},
		{"0x1::stake::ValidatorSet", &set},
		{"0x1::stake::ValidatorPerformance", &perf},
	} {
		if err := getJSON(ctx, client, res+q.path, q.out); err != nil {
			fail(aptosStateTag, err)
			return
		}
	}
	var flag []bool
	if err := aptosView(ctx, client, "0x1::features::is_enabled", []string{aptosRateFlag}, &flag); err != nil || len(flag) == 0 {
		fail(aptosStateTag, fmt.Errorf("feature flag: %v", err))
		return
	}
	rate, err := aptosPerEpochRate(flag[0], periodical.Data.RewardsRate.Value, legacy.Data.RewardsRate, legacy.Data.RewardsRateDenominator)
	if err != nil {
		fail(aptosStateTag, err)
		return
	}
	epochSec := parseFloat(blk.Data.EpochInterval) / 1e6
	if epochSec <= 0 {
		fail(aptosStateTag, fmt.Errorf("epoch_interval %q", blk.Data.EpochInterval))
		return
	}

	rows := make([]valRow, 0, len(set.Data.ActiveValidators))
	budget := aptosCommBudget
	for _, v := range set.Data.ActiveValidators {
		commissionBps, ok, fetched := aptosCommission(ctx, client, v.Addr, budget > 0)
		if fetched {
			budget--
		}
		if !ok {
			continue
		}
		var succ, failed int64
		if idx, err := strconv.Atoi(v.Config.ValidatorIndex); err == nil && idx >= 0 && idx < len(perf.Data.Validators) {
			p := perf.Data.Validators[idx]
			succ, _ = strconv.ParseInt(p.Successful, 10, 64)
			failed, _ = strconv.ParseInt(p.Failed, 10, 64)
		}
		gross, net, uptime := aptosNetBps(rate, epochSec, succ, failed, commissionBps)
		rows = append(rows, valRow{
			ID: v.Addr, Name: shortAddr(v.Addr),
			GrossBps: gross, NetBps: net, CommissionBps: commissionBps, UptimePct: uptime,
			StakeNative: parseFloat(v.VotingPower) / aptosOctas,
		})
	}
	if len(rows) == 0 {
		fail(aptosCommTag, fmt.Errorf("no delegation pool in the active set"))
		return
	}
	med := publishRows(aptosChain, rows, priceUSD(ctx, client, aptosChain, "aptos"))
	fmt.Printf("[aptos] published %d delegation pools, gross %.0f bps, median net %.0f bps\n",
		len(rows), rows[0].GrossBps, med)
}
