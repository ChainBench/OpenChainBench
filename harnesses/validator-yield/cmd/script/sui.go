package main

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// Sui. Source: the public Sui GraphQL RPC (graphql.mainnet.sui.io, no
// key).
//
// History: until 2026-11 this scraper called suix_getValidatorsApy on
// fullnode.mainnet.sui.io. Sui deprecated JSON-RPC on public fullnodes
// ("Method not found ... migrate to gRPC or GraphQL"), so every scrape
// failed (288 errors a day on Prom) and the Sui row was blank.
//
// Method (the one suix_getValidatorsApy itself used): each validator's
// staking pool has an exchange rate SUI per pool token,
// sui_balance / pool_token_balance. Epoch rewards, already net of the
// validator's commission (commission is paid to the validator as new
// pool tokens), raise that rate. So the delegator's realized APR over a
// window is
//
//	net_apr = (rate_now / rate_then − 1) × year / elapsed
//
// with rate_then read from the validator set of the epoch suiLookback
// epochs ago (the GraphQL `epoch(epochId:)` field serves historical
// validator sets) and elapsed from the two epochs' start timestamps.
// Validators that joined inside the window are skipped (no baseline).
// Gross = net / (1 − commission). Uptime is not exposed per validator
// and is published as 100. Verified 2026-11-03 (epochs 1270 → 1300):
// ~1.2% net APR, stake subsidies having decayed since launch.

const (
	suiChain    = "sui"
	suiGQLTag   = "sui_graphql"
	suiLookback = 30
	mistPerSui  = 1e9
	suiPageSize = 50
)

var suiGraphQLURL = envDefault("VAL_ECON_SUI_GRAPHQL_URL", "https://graphql.mainnet.sui.io/graphql")

type suiValidatorContents struct {
	Metadata struct {
		SuiAddress string `json:"sui_address"`
		Name       string `json:"name"`
	} `json:"metadata"`
	StakingPool struct {
		SuiBalance       string `json:"sui_balance"`
		PoolTokenBalance string `json:"pool_token_balance"`
	} `json:"staking_pool"`
	CommissionRate string `json:"commission_rate"` // bps
}

type suiEpochSet struct {
	EpochID    int64
	Start      time.Time
	Validators []suiValidatorContents
}

const suiEpochQuery = `query($id: UInt53, $after: String) {
  epoch(epochId: $id) {
    epochId
    startTimestamp
    validatorSet {
      activeValidators(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { contents { json } }
      }
    }
  }
}`

func fetchSuiEpoch(ctx context.Context, client *http.Client, epochID *int64) (suiEpochSet, error) {
	var set suiEpochSet
	var after *string
	for page := 0; page < 10; page++ {
		vars := map[string]any{"after": after}
		if epochID != nil {
			vars["id"] = *epochID
		} else {
			vars["id"] = nil
		}
		var resp struct {
			Data struct {
				Epoch *struct {
					EpochID        int64     `json:"epochId"`
					StartTimestamp time.Time `json:"startTimestamp"`
					ValidatorSet   struct {
						ActiveValidators struct {
							PageInfo struct {
								HasNextPage bool   `json:"hasNextPage"`
								EndCursor   string `json:"endCursor"`
							} `json:"pageInfo"`
							Nodes []struct {
								Contents struct {
									JSON suiValidatorContents `json:"json"`
								} `json:"contents"`
							} `json:"nodes"`
						} `json:"activeValidators"`
					} `json:"validatorSet"`
				} `json:"epoch"`
			} `json:"data"`
			Errors []struct {
				Message string `json:"message"`
			} `json:"errors"`
		}
		if err := postJSON(ctx, client, suiGraphQLURL, map[string]any{"query": suiEpochQuery, "variables": vars}, &resp); err != nil {
			return set, err
		}
		if len(resp.Errors) > 0 {
			return set, fmt.Errorf("graphql: %s", resp.Errors[0].Message)
		}
		e := resp.Data.Epoch
		if e == nil {
			return set, fmt.Errorf("graphql: no epoch")
		}
		set.EpochID, set.Start = e.EpochID, e.StartTimestamp
		for _, n := range e.ValidatorSet.ActiveValidators.Nodes {
			set.Validators = append(set.Validators, n.Contents.JSON)
		}
		if !e.ValidatorSet.ActiveValidators.PageInfo.HasNextPage {
			return set, nil
		}
		c := e.ValidatorSet.ActiveValidators.PageInfo.EndCursor
		after = &c
	}
	return set, fmt.Errorf("graphql: more than 10 pages of validators")
}

func suiRate(v suiValidatorContents) float64 {
	tok := parseFloat(v.StakingPool.PoolTokenBalance)
	if tok <= 0 {
		return 0
	}
	return parseFloat(v.StakingPool.SuiBalance) / tok
}

// suiNetAPR annualizes the pool exchange-rate growth.
func suiNetAPR(rateNow, rateThen, elapsedSeconds float64) float64 {
	if rateNow <= 0 || rateThen <= 0 || elapsedSeconds <= 0 {
		return 0
	}
	return (rateNow/rateThen - 1) * secondsPerYear / elapsedSeconds
}

func scrapeSui(ctx context.Context, client *http.Client) {
	fail := func(err error) {
		scrapeErrorsTotal.WithLabelValues(suiChain, suiGQLTag).Inc()
		fmt.Printf("[sui] graphql err: %v\n", err)
	}
	now, err := fetchSuiEpoch(ctx, client, nil)
	if err != nil {
		fail(err)
		return
	}
	thenID := now.EpochID - suiLookback
	then, err := fetchSuiEpoch(ctx, client, &thenID)
	if err != nil {
		fail(err)
		return
	}
	elapsed := now.Start.Sub(then.Start).Seconds()
	base := make(map[string]float64, len(then.Validators))
	for _, v := range then.Validators {
		base[v.Metadata.SuiAddress] = suiRate(v)
	}
	rows := make([]valRow, 0, len(now.Validators))
	for _, v := range now.Validators {
		r0, ok := base[v.Metadata.SuiAddress]
		if !ok {
			continue // joined inside the window
		}
		apr := suiNetAPR(suiRate(v), r0, elapsed)
		net := pctToBps(apr)
		comm := clamp(parseFloat(v.CommissionRate), 0, 10000)
		gross := net
		if comm < 10000 {
			gross = net / (1 - comm/10000)
		}
		name := v.Metadata.Name
		if name == "" {
			name = shortAddr(v.Metadata.SuiAddress)
		}
		rows = append(rows, valRow{
			ID: v.Metadata.SuiAddress, Name: name,
			GrossBps: gross, NetBps: net, CommissionBps: comm, UptimePct: 100,
			StakeNative: parseFloat(v.StakingPool.SuiBalance) / mistPerSui,
		})
	}
	if len(rows) == 0 {
		fail(fmt.Errorf("no validator present in both epoch %d and %d", now.EpochID, thenID))
		return
	}
	med := publishRows(suiChain, rows, priceUSD(ctx, client, suiChain, "sui"))
	fmt.Printf("[sui] published %d validators, epochs %d→%d (%.1f d), median net %.0f bps\n",
		len(rows), thenID, now.EpochID, elapsed/86400, med)
}
