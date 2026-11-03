package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
)

// Gram (formerly TON, slug `gram`). Source: TonAPI staking pools
// (tonapi.io/v2/staking/pools, keyless tier, one call per scrape) for
// the per-pool yield.
//
// TON has no protocol-level delegation: a holder stakes through a
// nominator pool contract, which runs (or funds) an elected validator
// and passes the elector's bonuses back net of the pool's fee. So the
// cohort is the VERIFIED nominator pools with stake (TON Whales queues
// and Tonkeeper queues on the Whales contract), whose TonAPI `apy` is
// the nominators' realized yield net of the pool fee. Liquid staking
// (Tonstakers, implementation liquidTF) is excluded for the same
// reason Lido is excluded on Ethereum: it is a product, not a
// validator. The ~1000 unverified single-nominator `tf` pools are
// excluded too: TonAPI gives them one shared modelled figure, not a
// measured one.
//
// TonAPI publishes APY (compounded every validation cycle); the bench
// is APR, so it is de-compounded over n = year / cycle_length cycles:
//
//	apr = n × ((1 + apy)^(1/n) − 1)
//
// On-chain cross-check (done by hand from TonAPI block value flows,
// not computed by the harness): elector income = `recovered`
// per masterchain block (1.7 GRAM masterchain + ~1 GRAM shardchain
// creation reward + fees, 2.7 GRAM) × masterchain blocks per year
// (0.423 s blocks) / elected stake (675M) = 29.9% per unit of stake
// while it is elected; stake is locked for a 131 072 s cycle to be
// elected 65 536 s of it, so a nominator earns about half: ~15% gross
// before pool fees. Verified 2026-11-03: Whales pools 12.55% APY
// (11.8% APR), Whales Club 13.7%.

const (
	gramChain    = "gram"
	gramPoolsTag = "tonapi_staking_pools"
	nanoGram     = 1e9
)

var tonapiURL = envDefault("VAL_ECON_TONAPI_URL", "https://tonapi.io")

type tonapiPool struct {
	Address        string  `json:"address"`
	Name           string  `json:"name"`
	TotalAmount    float64 `json:"total_amount"` // nanoGRAM
	Implementation string  `json:"implementation"`
	APY            float64 `json:"apy"` // percent
	Verified       bool    `json:"verified"`
	CycleLength    float64 `json:"cycle_length"` // seconds
}

// apyToAPR de-compounds a per-cycle compounded APY (fraction).
func apyToAPR(apy, cycleSeconds float64) float64 {
	if cycleSeconds <= 0 || apy <= -1 {
		return apy
	}
	n := secondsPerYear / cycleSeconds
	return n * (math.Pow(1+apy, 1/n) - 1)
}

// gramCohort keeps verified, funded, non-liquid nominator pools.
func gramCohort(pools []tonapiPool) []tonapiPool {
	out := []tonapiPool{}
	for _, p := range pools {
		if !p.Verified || p.TotalAmount <= 0 || p.Implementation == "liquidTF" {
			continue
		}
		out = append(out, p)
	}
	return out
}

func scrapeGram(ctx context.Context, client *http.Client) {
	var resp struct {
		Pools []tonapiPool `json:"pools"`
	}
	if err := getJSON(ctx, client, tonapiURL+"/v2/staking/pools", &resp); err != nil {
		scrapeErrorsTotal.WithLabelValues(gramChain, gramPoolsTag).Inc()
		fmt.Printf("[gram] tonapi pools err: %v\n", err)
		return
	}
	cohort := gramCohort(resp.Pools)
	if len(cohort) == 0 {
		scrapeErrorsTotal.WithLabelValues(gramChain, gramPoolsTag).Inc()
		fmt.Printf("[gram] no verified nominator pool in %d pools\n", len(resp.Pools))
		return
	}
	rows := make([]valRow, 0, len(cohort))
	for _, p := range cohort {
		apr := apyToAPR(p.APY/100, p.CycleLength)
		if apr <= 0 || apr > 0.5 {
			continue // TonAPI publishes 0 for a pool between cycles
		}
		bps := pctToBps(apr)
		rows = append(rows, valRow{
			ID: p.Address, Name: p.Name,
			// The pool fee is netted inside TonAPI's apy and not
			// exposed per pool, so gross = net and commission is not
			// written (-1) rather than published as a false 0.
			GrossBps: bps, NetBps: bps, CommissionBps: -1, UptimePct: 100,
			StakeNative: p.TotalAmount / nanoGram,
		})
	}
	if len(rows) == 0 {
		scrapeErrorsTotal.WithLabelValues(gramChain, gramPoolsTag).Inc()
		fmt.Printf("[gram] every verified pool had an implausible apy\n")
		return
	}
	med := publishRows(gramChain, rows, priceUSD(ctx, client, gramChain, "the-open-network"))
	fmt.Printf("[gram] published %d verified nominator pools, median net %.0f bps\n", len(rows), med)
}
