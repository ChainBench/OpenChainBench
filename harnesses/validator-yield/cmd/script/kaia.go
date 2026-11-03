package main

import (
	"context"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
)

// Kaia. Source: the public Kaia endpoint node JSON-RPC (no key).
//
// Reward rule: every block mints a fixed amount (9.6 KAIA on
// 2026-11-03), split by governance ratio between block rewards for
// the council (CN) stakers, KIF, KEF and KPF. `kaia_getRewards` returns
// the live per-block split; its `stakers` field (3.84 KAIA) is
// distributed pro rata to each CN's staked KAIA (verified: every CN
// earns the same reward per staked KAIA, to 4 significant digits).
// The proposer additionally keeps half the block's fees, which is
// noise next to minting and is excluded so the gross is one network
// rate:
//
//	gross_apr = stakers_per_block × blocks_per_year / Σ CN stake
//
// with blocks_per_year measured from block timestamps over the last
// 10 000 blocks and Σ CN stake from kaia_getStakingInfo (council plus
// CL pool staking amounts).
//
// Cohort: CNs with a KIP-163 public delegation (PD) contract, the
// only on-protocol way for a third party to stake. Net = gross × (1 −
// PD commissionRate/10000), commission read by eth_call on the PD.
// CNs without PD are operator-only stake and not in the cohort.
// Verified 2026-11-03: 4.10% gross, 13 PD-enabled CNs, commission 5%
// (12) and 10% (1).

const (
	kaiaChain    = "kaia"
	kaiaRPCTag   = "kaia_rpc"
	kaiaPDTag    = "kaia_public_delegation"
	kaiaBlockGap = 10000

	// 4-byte selectors (keccak256 of the signature).
	selIsPDEnabled      = "0xbfc7e948" // isPublicDelegationEnabled()
	selPublicDelegation = "0xe1a12d35" // publicDelegation()
	selCommissionRate   = "0x5ea1d6f8" // commissionRate()
)

var kaiaRPCURL = envDefault("VAL_ECON_KAIA_RPC_URL", "https://public-en.node.kaia.io")

type kaiaStakingInfo struct {
	CouncilStakingAddrs   []string  `json:"councilStakingAddrs"`
	CouncilRewardAddrs    []string  `json:"councilRewardAddrs"`
	CouncilNodeAddrs      []string  `json:"councilNodeAddrs"`
	CouncilStakingAmounts []float64 `json:"councilStakingAmounts"` // whole KAIA
	CLStakingInfos        []struct {
		CLNodeID        string  `json:"clNodeId"`
		CLStakingAmount float64 `json:"clStakingAmount"`
	} `json:"clStakingInfos"`
}

type kaiaRewards struct {
	Minted  *big.Int `json:"minted"`
	Stakers *big.Int `json:"stakers"`
}

// kaiaGrossAPR: per-block stakers reward (in kei) annualized over the
// total staked KAIA.
func kaiaGrossAPR(stakersKei *big.Int, blockSeconds, totalStakeKaia float64) float64 {
	if stakersKei == nil || blockSeconds <= 0 || totalStakeKaia <= 0 {
		return 0
	}
	perBlock, _ := new(big.Float).Quo(new(big.Float).SetInt(stakersKei), big.NewFloat(1e18)).Float64()
	return perBlock * (secondsPerYear / blockSeconds) / totalStakeKaia
}

func hexToFloat(h string) float64 {
	h = strings.TrimPrefix(strings.TrimSpace(h), "0x")
	if h == "" {
		return 0
	}
	v, ok := new(big.Int).SetString(h, 16)
	if !ok {
		return 0
	}
	f, _ := new(big.Float).SetInt(v).Float64()
	return f
}

func kaiaCall(ctx context.Context, client *http.Client, to, data string) (string, error) {
	var out string
	err := jsonRPC(ctx, client, kaiaRPCURL, "eth_call", []any{map[string]string{"to": to, "data": data}, "latest"}, &out)
	return out, err
}

func kaiaBlockSeconds(ctx context.Context, client *http.Client) (float64, error) {
	var head string
	if err := jsonRPC(ctx, client, kaiaRPCURL, "eth_blockNumber", nil, &head); err != nil {
		return 0, err
	}
	n := int64(hexToFloat(head))
	type blk struct {
		Timestamp string `json:"timestamp"`
	}
	var a, b blk
	if err := jsonRPC(ctx, client, kaiaRPCURL, "eth_getBlockByNumber", []any{"0x" + strconv.FormatInt(n, 16), false}, &a); err != nil {
		return 0, err
	}
	if err := jsonRPC(ctx, client, kaiaRPCURL, "eth_getBlockByNumber", []any{"0x" + strconv.FormatInt(n-kaiaBlockGap, 16), false}, &b); err != nil {
		return 0, err
	}
	dt := hexToFloat(a.Timestamp) - hexToFloat(b.Timestamp)
	if dt <= 0 {
		return 0, fmt.Errorf("kaia: non-increasing timestamps")
	}
	return dt / kaiaBlockGap, nil
}

func scrapeKaia(ctx context.Context, client *http.Client) {
	fail := func(tag string, err error) {
		scrapeErrorsTotal.WithLabelValues(kaiaChain, tag).Inc()
		fmt.Printf("[kaia] %s err: %v\n", tag, err)
	}
	var si kaiaStakingInfo
	if err := jsonRPC(ctx, client, kaiaRPCURL, "kaia_getStakingInfo", []any{"latest"}, &si); err != nil {
		fail(kaiaRPCTag, err)
		return
	}
	var rw kaiaRewards
	if err := jsonRPC(ctx, client, kaiaRPCURL, "kaia_getRewards", []any{"latest"}, &rw); err != nil {
		fail(kaiaRPCTag, err)
		return
	}
	bt, err := kaiaBlockSeconds(ctx, client)
	if err != nil {
		fail(kaiaRPCTag, err)
		return
	}
	if len(si.CouncilStakingAddrs) != len(si.CouncilStakingAmounts) || len(si.CouncilStakingAddrs) != len(si.CouncilRewardAddrs) {
		fail(kaiaRPCTag, fmt.Errorf("staking info arrays misaligned"))
		return
	}
	var total float64
	for _, a := range si.CouncilStakingAmounts {
		total += a
	}
	for _, c := range si.CLStakingInfos {
		total += c.CLStakingAmount
	}
	apr := kaiaGrossAPR(rw.Stakers, bt, total)
	if apr <= 0 || apr > 0.5 {
		fail(kaiaRPCTag, fmt.Errorf("implausible gross APR %.4f (block %.3fs, stake %.0f)", apr, bt, total))
		return
	}
	gross := pctToBps(apr)

	// One row per staking contract with PD enabled. Stake per row is
	// the staking contract's own amount (the PD deposits into it).
	rows := []valRow{}
	for i, sa := range si.CouncilStakingAddrs {
		en, err := kaiaCall(ctx, client, sa, selIsPDEnabled)
		if err != nil || hexToFloat(en) != 1 {
			continue // older CnStaking (no PD) or PD disabled
		}
		pd, err := kaiaCall(ctx, client, sa, selPublicDelegation)
		if err != nil || len(pd) < 42 {
			fail(kaiaPDTag, fmt.Errorf("publicDelegation() on %s: %v", sa, err))
			continue
		}
		pdAddr := "0x" + pd[len(pd)-40:]
		cr, err := kaiaCall(ctx, client, pdAddr, selCommissionRate)
		if err != nil {
			fail(kaiaPDTag, fmt.Errorf("commissionRate() on %s: %v", pdAddr, err))
			continue
		}
		comm := hexToFloat(cr) // basis points, MAX 10000
		label := "CN " + shortAddr(sa)
		if i < len(si.CouncilNodeAddrs) {
			label = "CN " + shortAddr(si.CouncilNodeAddrs[i])
		}
		rows = append(rows, valRow{
			ID: pdAddr, Name: label,
			GrossBps: gross, NetBps: gross * (1 - clamp(comm, 0, 10000)/10000),
			CommissionBps: comm, UptimePct: 100,
			StakeNative: si.CouncilStakingAmounts[i],
		})
	}
	if len(rows) == 0 {
		fail(kaiaPDTag, fmt.Errorf("no public delegation CN found"))
		return
	}
	med := publishRows(kaiaChain, rows, priceUSD(ctx, client, kaiaChain, "kaia"))
	fmt.Printf("[kaia] published %d PD council nodes, gross %.0f bps (block %.3fs, staked %.0fM), median net %.0f bps\n",
		len(rows), gross, bt, total/1e6, med)
}
