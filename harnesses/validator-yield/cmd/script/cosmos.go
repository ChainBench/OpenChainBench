package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// Cosmos-SDK chains: Cosmos Hub, Sei, Cronos (the Cronos POS chain,
// where CRO is staked; the Cronos EVM chain has no public staking).
// Source: each chain's public LCD REST (PublicNode / crypto.org, no key).
//
// Network gross APR is the standard staking APR every Cosmos explorer
// computes, from live chain state:
//
//	gross = annual_issuance × (1 − community_tax) / bonded_tokens
//
// annual_issuance:
//   - x/mint chains (Hub, Cronos): annual_provisions × actual blocks
//     per year / the mint module's blocks_per_year param. The module
//     mints annual_provisions / blocks_per_year PER BLOCK, so when real
//     blocks are faster than the param assumes, real issuance is
//     higher (Hub: ~6 s blocks against a 7.2 s param).
//   - Sei (custom seichain mint, fixed token release schedule): the
//     current period's total_mint_amount annualized over the period.
// community_tax from x/distribution params (live, not hard-coded).
// Fees are excluded (inflation-only, like Cardano and Sui).
//
// Per validator: net = gross × (1 − commission), jailed → 0. Uptime is
// published as 100: missed blocks are not fetched (signing info would
// be one more paginated call per chain).
//
// History: until 2026-11 this file computed
// inflation × (1 − 0.02) / (bonded / (bonded + not_bonded)). That
// denominator is not the bonded ratio (not_bonded_tokens is only the
// unbonding queue, not the liquid supply), so the Hub figure read
// ~10.3% gross against a real ~15.5%.

type cosmosChainCfg struct {
	Chain    string
	LCD      string
	Decimals float64 // base units per token
	PriceID  string
	SeiMint  bool // custom seichain mint module
	TopN     int
}

var cosmosChains = []cosmosChainCfg{
	{Chain: "cosmos-hub", LCD: envDefault("VAL_ECON_COSMOS_LCD_URL", "https://cosmos-rest.publicnode.com"), Decimals: 1e6, PriceID: "cosmos", TopN: 200},
	{Chain: "sei", LCD: envDefault("VAL_ECON_SEI_LCD_URL", "https://sei-rest.publicnode.com"), Decimals: 1e6, PriceID: "sei-network", SeiMint: true, TopN: 200},
	{Chain: "cronos", LCD: envDefault("VAL_ECON_CRONOS_LCD_URL", "https://rest.mainnet.crypto.org"), Decimals: 1e8, PriceID: "crypto-com-chain", TopN: 200},
}

const cosmosBlockGap = 20000

type cosmosValidator struct {
	OperatorAddress string `json:"operator_address"`
	Tokens          string `json:"tokens"`
	Jailed          bool   `json:"jailed"`
	Description     struct {
		Moniker string `json:"moniker"`
	} `json:"description"`
	Commission struct {
		CommissionRates struct {
			Rate string `json:"rate"`
		} `json:"commission_rates"`
	} `json:"commission"`
}

// cosmosGrossAPR = issuance × (1 − tax) / bonded.
func cosmosGrossAPR(annualIssuance, communityTax, bonded float64) float64 {
	if bonded <= 0 {
		return 0
	}
	return annualIssuance * (1 - communityTax) / bonded
}

// mintAnnualIssuance corrects x/mint annual_provisions for real block
// speed. blockSeconds <= 0 or paramBlocksPerYear <= 0 → uncorrected.
func mintAnnualIssuance(annualProvisions, paramBlocksPerYear, blockSeconds float64) float64 {
	if paramBlocksPerYear <= 0 || blockSeconds <= 0 {
		return annualProvisions
	}
	return annualProvisions * (secondsPerYear / blockSeconds) / paramBlocksPerYear
}

// seiAnnualIssuance annualizes the active release period.
func seiAnnualIssuance(totalMint float64, start, end string) (float64, error) {
	s, err1 := time.Parse("2006-01-02", start)
	e, err2 := time.Parse("2006-01-02", end)
	if err1 != nil || err2 != nil || !e.After(s) {
		return 0, fmt.Errorf("sei release period %q..%q", start, end)
	}
	days := e.Sub(s).Hours()/24 + 1 // end date inclusive
	return totalMint * 365.25 / days, nil
}

func cosmosBlockSeconds(ctx context.Context, client *http.Client, lcd string) (float64, error) {
	type blk struct {
		Block struct {
			Header struct {
				Height string    `json:"height"`
				Time   time.Time `json:"time"`
			} `json:"header"`
		} `json:"block"`
	}
	var head, old blk
	if err := getJSON(ctx, client, lcd+"/cosmos/base/tendermint/v1beta1/blocks/latest", &head); err != nil {
		return 0, err
	}
	h, err := strconv.ParseInt(head.Block.Header.Height, 10, 64)
	if err != nil || h <= cosmosBlockGap {
		return 0, fmt.Errorf("bad head height %q", head.Block.Header.Height)
	}
	if err := getJSON(ctx, client, fmt.Sprintf("%s/cosmos/base/tendermint/v1beta1/blocks/%d", lcd, h-cosmosBlockGap), &old); err != nil {
		return 0, err
	}
	dt := head.Block.Header.Time.Sub(old.Block.Header.Time).Seconds()
	if dt <= 0 {
		return 0, fmt.Errorf("non-increasing block times")
	}
	return dt / cosmosBlockGap, nil
}

func cosmosAnnualIssuance(ctx context.Context, client *http.Client, c cosmosChainCfg) (float64, string, error) {
	if c.SeiMint {
		var m struct {
			StartDate       string `json:"start_date"`
			EndDate         string `json:"end_date"`
			TotalMintAmount string `json:"total_mint_amount"`
		}
		if err := getJSON(ctx, client, c.LCD+"/seichain/mint/v1beta1/minter", &m); err != nil {
			return 0, "", err
		}
		v, err := seiAnnualIssuance(parseFloat(m.TotalMintAmount), m.StartDate, m.EndDate)
		return v, fmt.Sprintf("release %s..%s", m.StartDate, m.EndDate), err
	}
	var ap struct {
		AnnualProvisions string `json:"annual_provisions"`
	}
	if err := getJSON(ctx, client, c.LCD+"/cosmos/mint/v1beta1/annual_provisions", &ap); err != nil {
		return 0, "", err
	}
	var mp struct {
		Params struct {
			BlocksPerYear string `json:"blocks_per_year"`
		} `json:"params"`
	}
	if err := getJSON(ctx, client, c.LCD+"/cosmos/mint/v1beta1/params", &mp); err != nil {
		return 0, "", err
	}
	bt, err := cosmosBlockSeconds(ctx, client, c.LCD)
	if err != nil {
		// Fall back to the uncorrected provisions rather than drop
		// the chain; the log says so.
		fmt.Printf("[%s] block time err (issuance uncorrected): %v\n", c.Chain, err)
		bt = 0
	}
	param := parseFloat(mp.Params.BlocksPerYear)
	return mintAnnualIssuance(parseFloat(ap.AnnualProvisions), param, bt),
		fmt.Sprintf("block %.2fs vs param %.0f/yr", bt, param), nil
}

func scrapeCosmosChain(c cosmosChainCfg) func(context.Context, *http.Client) {
	return func(ctx context.Context, client *http.Client) {
		fail := func(tag string, err error) {
			scrapeErrorsTotal.WithLabelValues(c.Chain, tag).Inc()
			fmt.Printf("[%s] %s err: %v\n", c.Chain, tag, err)
		}
		issuance, note, err := cosmosAnnualIssuance(ctx, client, c)
		if err != nil {
			fail("lcd_mint", err)
			return
		}
		var pool struct {
			Pool struct {
				BondedTokens string `json:"bonded_tokens"`
			} `json:"pool"`
		}
		if err := getJSON(ctx, client, c.LCD+"/cosmos/staking/v1beta1/pool", &pool); err != nil {
			fail("lcd_pool", err)
			return
		}
		var dist struct {
			Params struct {
				CommunityTax string `json:"community_tax"`
			} `json:"params"`
		}
		if err := getJSON(ctx, client, c.LCD+"/cosmos/distribution/v1beta1/params", &dist); err != nil {
			fail("lcd_distribution", err)
			return
		}
		var vals struct {
			Validators []cosmosValidator `json:"validators"`
		}
		if err := getJSON(ctx, client, c.LCD+"/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=500", &vals); err != nil {
			fail("lcd_validators", err)
			return
		}
		bonded := parseFloat(pool.Pool.BondedTokens)
		tax := parseFloat(dist.Params.CommunityTax)
		apr := cosmosGrossAPR(issuance, tax, bonded)
		if apr <= 0 || apr > 1 {
			fail("lcd_mint", fmt.Errorf("implausible gross APR %.4f (issuance %.0f, bonded %.0f)", apr, issuance, bonded))
			return
		}
		gross := pctToBps(apr)
		rows := make([]valRow, 0, len(vals.Validators))
		for _, v := range vals.Validators {
			comm := clamp(parseFloat(v.Commission.CommissionRates.Rate), 0, 1)
			net := gross * (1 - comm)
			if v.Jailed {
				net = 0
			}
			rows = append(rows, valRow{
				ID: v.OperatorAddress, Name: v.Description.Moniker,
				GrossBps: gross, NetBps: net, CommissionBps: comm * 10000, UptimePct: 100,
				StakeNative: parseFloat(v.Tokens) / c.Decimals, Jailed: v.Jailed,
			})
		}
		rows = topNByStake(rows, c.TopN)
		if len(rows) == 0 {
			fail("lcd_validators", fmt.Errorf("no bonded validator"))
			return
		}
		med := publishRows(c.Chain, rows, priceUSD(ctx, client, c.Chain, c.PriceID))
		fmt.Printf("[%s] published %d validators, gross %.0f bps (issuance %.0fM, bonded %.0fM, tax %.2f, %s), median net %.0f bps\n",
			c.Chain, len(rows), gross, issuance/c.Decimals/1e6, bonded/c.Decimals/1e6, tax, note, med)
	}
}
