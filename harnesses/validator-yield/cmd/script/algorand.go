package main

import (
	"context"
	"fmt"
	"net/http"
)

// Algorand. Source: a public algod REST API (Nodely's free tier at
// mainnet-api.algonode.cloud, no key).
//
// Reward rule (consensus incentives, live since protocol v40, Jan
// 2025): the proposer of each block is paid `pp` (proposer payout =
// the protocol bonus `bi` plus 50% of the block's fees) IF its account
// is incentive-eligible (opted in with the 2 ALGO fee, 30k to 70M ALGO
// online). Ineligible proposers produce blocks with pp = 0. Proposer
// selection is stake-weighted across ALL online stake, so an eligible
// account with stake s expects blocks_per_year × s / online_stake
// proposals, each paying the eligible-block average payout:
//
//	apr = blocks_per_year × mean(pp | pp > 0) / online_stake
//
// online_stake from /v2/ledger/supply, pp from the last algoSample
// blocks, blocks_per_year from the timestamps of the head block and
// the block algoGap rounds earlier.
//
// What this is: the yield of running your own participating node
// (opt-in node operation; no delegation, no commission, no lockup).
// Holding ALGO without running a node earns nothing at protocol
// level. Published as ONE synthetic series like Ethereum. Verified
// 2026-11-03: block 2.78 s, mean eligible payout 8.19 ALGO, online
// stake 2.01B ALGO → 4.62% APR. The bonus decays 1% every 1M rounds,
// so this figure drifts down over time by design.

const (
	algorandChain = "algorand"
	algorandTag   = "algod"
	algoSample    = 40
	algoGap       = 10000
	microAlgo     = 1e6
)

var algodURL = envDefault("VAL_ECON_ALGOD_URL", "https://mainnet-api.algonode.cloud")

type algoBlock struct {
	Block struct {
		Round int64 `json:"rnd"`
		TS    int64 `json:"ts"`
		PP    int64 `json:"pp"` // proposer payout, microAlgo
	} `json:"block"`
}

// algorandAPR: expected yield for an incentive-eligible online account.
func algorandAPR(blockSeconds float64, payoutsMicro []int64, onlineStakeMicro float64) (float64, int) {
	var sum float64
	n := 0
	for _, p := range payoutsMicro {
		if p > 0 {
			sum += float64(p)
			n++
		}
	}
	if n == 0 || blockSeconds <= 0 || onlineStakeMicro <= 0 {
		return 0, n
	}
	return (secondsPerYear / blockSeconds) * (sum / float64(n)) / onlineStakeMicro, n
}

func algoGetBlock(ctx context.Context, client *http.Client, round int64) (algoBlock, error) {
	var b algoBlock
	err := getJSON(ctx, client, fmt.Sprintf("%s/v2/blocks/%d?format=json", algodURL, round), &b)
	return b, err
}

func scrapeAlgorand(ctx context.Context, client *http.Client) {
	fail := func(err error) {
		scrapeErrorsTotal.WithLabelValues(algorandChain, algorandTag).Inc()
		fmt.Printf("[algorand] algod err: %v\n", err)
	}
	var sup struct {
		Round       int64   `json:"current_round"`
		OnlineStake float64 `json:"online-stake"`
		OnlineMoney float64 `json:"online-money"`
	}
	if err := getJSON(ctx, client, algodURL+"/v2/ledger/supply", &sup); err != nil {
		fail(err)
		return
	}
	online := sup.OnlineStake
	if online <= 0 {
		online = sup.OnlineMoney
	}
	payouts := make([]int64, 0, algoSample)
	var headTS int64
	for i := int64(0); i < algoSample; i++ {
		b, err := algoGetBlock(ctx, client, sup.Round-i)
		if err != nil {
			fail(err)
			return
		}
		if i == 0 {
			headTS = b.Block.TS
		}
		payouts = append(payouts, b.Block.PP)
	}
	old, err := algoGetBlock(ctx, client, sup.Round-algoGap)
	if err != nil {
		fail(err)
		return
	}
	bt := float64(headTS-old.Block.TS) / algoGap
	apr, eligible := algorandAPR(bt, payouts, online)
	if apr <= 0 || apr > 0.5 {
		fail(fmt.Errorf("implausible APR %.4f (block %.2fs, %d/%d eligible blocks)", apr, bt, eligible, algoSample))
		return
	}
	bps := pctToBps(apr)
	row := valRow{
		ID: "incentive-eligible-node", Name: "Algorand eligible node (network avg)",
		GrossBps: bps, NetBps: bps, CommissionBps: 0, UptimePct: 100,
		StakeNative: online / microAlgo,
	}
	publishRows(algorandChain, []valRow{row}, priceUSD(ctx, client, algorandChain, "algorand"))
	fmt.Printf("[algorand] published eligible-node APR %.0f bps (block %.2fs, %d/%d eligible blocks, online %.0fM ALGO)\n",
		bps, bt, eligible, algoSample, online/microAlgo/1e6)
}
