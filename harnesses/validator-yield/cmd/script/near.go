package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// NEAR. Source: a public NEAR JSON-RPC (FastNEAR free tier,
// free.rpc.fastnear.com, no key; rpc.mainnet.fastnear.com 429s keyless
// callers quickly).
//
// Reward rule (nearcore reward_calculator.rs): each epoch the protocol
// mints total_supply × max_inflation_rate × epoch_duration / year,
// sends protocol_reward_rate of it to the treasury, and splits the
// rest across validators pro rata to stake, scaled by each validator's
// online ratio: 0 below online_min_threshold (90%), linear up to full
// reward at online_max_threshold (99%). So the network gross APR is
//
//	total_supply × max_inflation_rate × (1 − protocol_reward_rate) / total_stake
//
// read live from EXPERIMENTAL_protocol_config (max_inflation_rate,
// protocol_reward_rate, online thresholds), the latest block header
// (total_supply) and `validators` (stakes and produced/expected
// blocks, chunks and endorsements for the current epoch).
//
// Verified 2026-11-03: max_inflation 1/40 (2.5%, halved by the 2025
// vote), protocol_reward_rate 0, supply 1.311B NEAR, stake 593M NEAR
// → 5.52% gross. The realized previous epoch (validator_reward_paid_
// prev_epoch over its 6.88 h duration) annualizes to 5.47%.
//
// Cohort: the top 200 current validators by stake that are staking
// pool contracts (get_reward_fee_fraction answers); net = gross ×
// online factor × (1 − pool fee). Fees are cached for 6 h: they change
// rarely, there are ~370 pools and the keyless FastNEAR tier
// rate-limits.

const (
	nearChain     = "near"
	nearRPCTag    = "near_rpc"
	nearFeeTag    = "near_pool_fee"
	nearTopN      = 200
	nearFeeTTL    = 6 * time.Hour
	nearFeeBudget = 40
	yoctoPerNear  = 1e24
)

var (
	nearRPCURL         = envDefault("VAL_ECON_NEAR_RPC_URL", "https://free.rpc.fastnear.com")
	nearRPCFallbackURL = envDefault("VAL_ECON_NEAR_RPC_FALLBACK_URL", "https://rpc.mainnet.near.org")
)

// nearRPC tries the primary endpoint, then the fallback when the
// primary rate-limits or fails at the transport/HTTP level. An RPC
// error from the node itself (e.g. no such contract) is returned as is.
func nearRPC(ctx context.Context, client *http.Client, method string, params any, out any) error {
	err := jsonRPC(ctx, client, nearRPCURL, method, params, out)
	if err == nil || nearNotAPool(err) || nearRPCFallbackURL == "" || ctx.Err() != nil {
		return err
	}
	return jsonRPC(ctx, client, nearRPCFallbackURL, method, params, out)
}

type nearProtocolConfig struct {
	MaxInflationRate   [2]float64 `json:"max_inflation_rate"`
	ProtocolRewardRate [2]float64 `json:"protocol_reward_rate"`
	OnlineMinThreshold [2]float64 `json:"online_min_threshold"`
	OnlineMaxThreshold [2]float64 `json:"online_max_threshold"`
}

type nearValidator struct {
	AccountID               string `json:"account_id"`
	Stake                   string `json:"stake"`
	IsSlashed               bool   `json:"is_slashed"`
	NumExpectedBlocks       int64  `json:"num_expected_blocks"`
	NumProducedBlocks       int64  `json:"num_produced_blocks"`
	NumExpectedChunks       int64  `json:"num_expected_chunks"`
	NumProducedChunks       int64  `json:"num_produced_chunks"`
	NumExpectedEndorsements int64  `json:"num_expected_endorsements"`
	NumProducedEndorsements int64  `json:"num_produced_endorsements"`
}

type nearValidatorsResult struct {
	CurrentValidators []nearValidator `json:"current_validators"`
}

// nearOnlineRatio averages produced/expected over the duties the
// validator actually had this epoch (blocks, chunks, endorsements), as
// nearcore does. No duty yet → 1 (no evidence of downtime).
func nearOnlineRatio(v nearValidator) float64 {
	var sum float64
	var n int
	for _, p := range [][2]int64{
		{v.NumProducedBlocks, v.NumExpectedBlocks},
		{v.NumProducedChunks, v.NumExpectedChunks},
		{v.NumProducedEndorsements, v.NumExpectedEndorsements},
	} {
		if p[1] > 0 {
			sum += float64(p[0]) / float64(p[1])
			n++
		}
	}
	if n == 0 {
		return 1
	}
	return sum / float64(n)
}

// nearRewardFactor maps an online ratio to the share of the full
// reward the protocol pays: 0 under min, 1 at or above max, linear in
// between.
func nearRewardFactor(online, minT, maxT float64) float64 {
	if online < minT {
		return 0
	}
	if online >= maxT || maxT <= minT {
		return 1
	}
	return (online - minT) / (maxT - minT)
}

// nearNetworkAPR = supply × inflation × (1 − protocol share) / stake.
func nearNetworkAPR(totalSupply, totalStake, inflation, protocolShare float64) float64 {
	if totalStake <= 0 {
		return 0
	}
	return totalSupply * inflation * (1 - protocolShare) / totalStake
}

func ratio(r [2]float64) float64 {
	if r[1] == 0 {
		return 0
	}
	return r[0] / r[1]
}

func yoctoToNear(s string) float64 {
	v, ok := new(big.Float).SetString(s)
	if !ok {
		return 0
	}
	f, _ := new(big.Float).Quo(v, big.NewFloat(yoctoPerNear)).Float64()
	return f
}

var nearFeeCache = struct {
	sync.Mutex
	at  map[string]time.Time
	fee map[string]float64 // fraction, -1 = not a staking pool
}{at: map[string]time.Time{}, fee: map[string]float64{}}

// nearPoolFee returns (fee fraction, known). fee < 0 = not a staking
// pool. A fresh cache entry is returned as is; otherwise one view call
// is made when mayFetch, and a failed refresh falls back to the stale
// value so a rate limit never drops a pool that was known.
func nearPoolFee(ctx context.Context, client *http.Client, pool string, mayFetch bool) (float64, bool, bool) {
	nearFeeCache.Lock()
	t, cached := nearFeeCache.at[pool]
	stale := nearFeeCache.fee[pool]
	nearFeeCache.Unlock()
	if cached && time.Since(t) < nearFeeTTL {
		return stale, true, false
	}
	if !mayFetch {
		return stale, cached, false
	}

	var out struct {
		Result []int `json:"result"` // raw bytes as a JSON array of ints
	}
	fee := -1.0
	err := nearRPC(ctx, client, "query", map[string]any{
		"request_type": "call_function", "finality": "final", "account_id": pool,
		"method_name": "get_reward_fee_fraction", "args_base64": base64.StdEncoding.EncodeToString([]byte("{}")),
	}, &out)
	if err == nil {
		var frac struct {
			Numerator   float64 `json:"numerator"`
			Denominator float64 `json:"denominator"`
		}
		raw := make([]byte, len(out.Result))
		for i, b := range out.Result {
			raw[i] = byte(b)
		}
		if json.Unmarshal(raw, &frac) == nil && frac.Denominator > 0 {
			fee = frac.Numerator / frac.Denominator
		}
	} else if !nearNotAPool(err) {
		// 429, timeout, node hiccup: keep the stale value if any.
		scrapeErrorsTotal.WithLabelValues(nearChain, nearFeeTag).Inc()
		return stale, cached, true
	}
	nearFeeCache.Lock()
	nearFeeCache.at[pool] = time.Now()
	nearFeeCache.fee[pool] = fee
	nearFeeCache.Unlock()
	return fee, true, true
}

// nearNotAPool is true when the view call failed because the account
// has no contract or no get_reward_fee_fraction method, i.e. it is a
// validator key, not a staking pool anyone can delegate to.
func nearNotAPool(err error) bool {
	m := err.Error()
	for _, k := range []string{"CodeDoesNotExist", "MethodNotFound", "MethodResolveError", "does not exist while viewing"} {
		if strings.Contains(m, k) {
			return true
		}
	}
	return false
}

func scrapeNear(ctx context.Context, client *http.Client) {
	fail := func(tag string, err error) {
		scrapeErrorsTotal.WithLabelValues(nearChain, tag).Inc()
		fmt.Printf("[near] %s err: %v\n", tag, err)
	}
	var cfg nearProtocolConfig
	if err := nearRPC(ctx, client, "EXPERIMENTAL_protocol_config", map[string]any{"finality": "final"}, &cfg); err != nil {
		fail(nearRPCTag, err)
		return
	}
	var blk struct {
		Header struct {
			TotalSupply string `json:"total_supply"`
		} `json:"header"`
	}
	if err := nearRPC(ctx, client, "block", map[string]any{"finality": "final"}, &blk); err != nil {
		fail(nearRPCTag, err)
		return
	}
	var vs nearValidatorsResult
	if err := nearRPC(ctx, client, "validators", []any{nil}, &vs); err != nil {
		fail(nearRPCTag, err)
		return
	}
	supply := yoctoToNear(blk.Header.TotalSupply)
	var totalStake float64
	rows := make([]valRow, 0, len(vs.CurrentValidators))
	for _, v := range vs.CurrentValidators {
		st := yoctoToNear(v.Stake)
		totalStake += st
		rows = append(rows, valRow{ID: v.AccountID, Name: v.AccountID, StakeNative: st, Jailed: v.IsSlashed})
	}
	inflation, protocolShare := ratio(cfg.MaxInflationRate), ratio(cfg.ProtocolRewardRate)
	apr := nearNetworkAPR(supply, totalStake, inflation, protocolShare)
	if apr <= 0 || apr > 0.5 || supply <= 0 {
		fail(nearRPCTag, fmt.Errorf("implausible APR %.4f (supply %.0f, stake %.0f, inflation %.4f)", apr, supply, totalStake, inflation))
		return
	}
	gross := pctToBps(apr)
	minT, maxT := ratio(cfg.OnlineMinThreshold), ratio(cfg.OnlineMaxThreshold)

	byID := make(map[string]nearValidator, len(vs.CurrentValidators))
	for _, v := range vs.CurrentValidators {
		byID[v.AccountID] = v
	}
	rows = topNByStake(rows, nearTopN)
	// Pool fees: at most nearFeeBudget view calls per scrape, in stake
	// order, so a cold start fills the cohort over a few cycles and the
	// 6 h refreshes spread out instead of bursting 200 calls at the
	// keyless endpoint. Pools whose fee is not known yet are skipped.
	fees := make([]float64, len(rows))
	known := make([]bool, len(rows))
	budget := nearFeeBudget
	for i := range rows {
		f, k, fetched := nearPoolFee(ctx, client, rows[i].ID, budget > 0)
		if fetched {
			budget--
		}
		fees[i], known[i] = f, k
	}
	out := rows[:0]
	for i, r := range rows {
		fee := fees[i]
		if !known[i] || fee < 0 {
			continue // not a staking pool contract, no third-party stake
		}
		v := byID[r.ID]
		online := nearOnlineRatio(v)
		factor := nearRewardFactor(online, minT, maxT)
		if v.IsSlashed {
			factor = 0
		}
		r.GrossBps = gross
		r.CommissionBps = fee * 10000
		r.UptimePct = online * 100
		r.NetBps = gross * factor * (1 - fee)
		out = append(out, r)
	}
	if len(out) == 0 {
		fail(nearFeeTag, fmt.Errorf("no staking pool answered get_reward_fee_fraction"))
		return
	}
	med := publishRows(nearChain, out, priceUSD(ctx, client, nearChain, "near"))
	fmt.Printf("[near] published %d pools, gross %.0f bps (supply %.0fM, stake %.0fM, inflation %.2f%%), median net %.0f bps\n",
		len(out), gross, supply/1e6, totalStake/1e6, inflation*100, med)
}
