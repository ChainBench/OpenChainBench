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
	cosmosChain              = "cosmos-hub"
	cosmosInflationTag       = "cosmos_lcd_inflation"
	cosmosPoolTag            = "cosmos_lcd_pool"
	cosmosValidatorsTag      = "cosmos_lcd_validators"
	coingeckoAtomSourceTag   = "coingecko_atom"

	// Cosmos Hub community_tax has been ~2% for years; hard-coding
	// avoids a third LCD round-trip per scrape. If governance changes
	// it materially, update here (grep this constant).
	cosmosCommunityTax = 0.02

	// Cap: Cosmos Hub has ~180 active validators (top 180 in bond
	// order). We publish all of them — the tail is small enough to
	// not blow up cardinality.
	cosmosTopN = 200
)

var (
	cosmosLCDBase = envDefault("VAL_ECON_COSMOS_LCD_URL", "https://cosmos-rest.publicnode.com")
	coingeckoAtomURL = envDefault("VAL_ECON_COINGECKO_ATOM_URL", "https://api.coingecko.com/api/v3/simple/price?ids=cosmos&vs_currencies=usd")
)

// cosmosInflationResponse mirrors /cosmos/mint/v1beta1/inflation.
// `inflation` is a decimal string in [0,1] (0.1 = 10%).
type cosmosInflationResponse struct {
	Inflation string `json:"inflation"`
}

// cosmosPoolResponse mirrors /cosmos/staking/v1beta1/pool. Token amounts
// are stringified integer uatom (1 ATOM = 1e6 uatom).
type cosmosPoolResponse struct {
	Pool struct {
		BondedTokens    string `json:"bonded_tokens"`
		NotBondedTokens string `json:"not_bonded_tokens"`
	} `json:"pool"`
}

// cosmosValidator mirrors items in /cosmos/staking/v1beta1/validators.
type cosmosValidator struct {
	OperatorAddress string `json:"operator_address"`
	Status          string `json:"status"`
	Tokens          string `json:"tokens"`
	Description     struct {
		Moniker  string `json:"moniker"`
		Identity string `json:"identity"`
	} `json:"description"`
	Commission struct {
		CommissionRates struct {
			Rate          string `json:"rate"`
			MaxRate       string `json:"max_rate"`
			MaxChangeRate string `json:"max_change_rate"`
		} `json:"commission_rates"`
	} `json:"commission"`
	Jailed bool `json:"jailed"`
}

type cosmosValidatorsResponse struct {
	Validators []cosmosValidator `json:"validators"`
	Pagination struct {
		NextKey *string `json:"next_key"`
		Total   string  `json:"total"`
	} `json:"pagination"`
}

func lcdGet(ctx context.Context, client *http.Client, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-harness/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("lcd http %d: %s", resp.StatusCode, url)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

func fetchCosmosInflation(ctx context.Context, client *http.Client) (float64, error) {
	var out cosmosInflationResponse
	if err := lcdGet(ctx, client, cosmosLCDBase+"/cosmos/mint/v1beta1/inflation", &out); err != nil {
		return 0, err
	}
	v := parseFloat(out.Inflation)
	if v <= 0 || v > 1 {
		return 0, fmt.Errorf("cosmos inflation implausible: %s", out.Inflation)
	}
	return v, nil
}

func fetchCosmosPool(ctx context.Context, client *http.Client) (bonded, notBonded float64, err error) {
	var out cosmosPoolResponse
	if err = lcdGet(ctx, client, cosmosLCDBase+"/cosmos/staking/v1beta1/pool", &out); err != nil {
		return 0, 0, err
	}
	bonded = parseFloat(out.Pool.BondedTokens)
	notBonded = parseFloat(out.Pool.NotBondedTokens)
	if bonded <= 0 {
		return 0, 0, fmt.Errorf("cosmos pool: bonded_tokens=0")
	}
	return bonded, notBonded, nil
}

func fetchCosmosValidators(ctx context.Context, client *http.Client) ([]cosmosValidator, error) {
	url := cosmosLCDBase + "/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=250"
	var out cosmosValidatorsResponse
	if err := lcdGet(ctx, client, url, &out); err != nil {
		return nil, err
	}
	return out.Validators, nil
}

func fetchCosmosPrice(ctx context.Context, client *http.Client) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, coingeckoAtomURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-harness/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("coingecko atom http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var payload map[string]map[string]float64
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, fmt.Errorf("coingecko atom parse: %w", err)
	}
	v, ok := payload["cosmos"]
	if !ok {
		return 0, fmt.Errorf("coingecko missing cosmos key")
	}
	price := v["usd"]
	if price <= 0 {
		return 0, fmt.Errorf("coingecko invalid atom price %f", price)
	}
	return price, nil
}

// scrapeCosmos computes Cosmos Hub validator yield from LCD REST:
//
//	network_apr = inflation × (1 - community_tax) / bonded_ratio
//	net_apr     = network_apr × (1 - commission_rate)
//
// Uptime is set to 100% — Cosmos Hub does surface missed_blocks via
// /cosmos/slashing/v1beta1/signing_infos but we skip that in v1 to
// keep the scrape to a single validators-pagination call.
func scrapeCosmos(ctx context.Context, client *http.Client) {
	inflation, err := fetchCosmosInflation(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(cosmosChain, cosmosInflationTag).Inc()
		fmt.Printf("[cosmos-hub] inflation err: %v\n", err)
		return
	}

	bonded, notBonded, err := fetchCosmosPool(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(cosmosChain, cosmosPoolTag).Inc()
		fmt.Printf("[cosmos-hub] pool err: %v\n", err)
		return
	}
	bondedRatio := bonded / (bonded + notBonded)
	if bondedRatio <= 0 || bondedRatio > 1 {
		fmt.Printf("[cosmos-hub] implausible bonded_ratio %.4f, aborting\n", bondedRatio)
		return
	}

	validators, err := fetchCosmosValidators(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(cosmosChain, cosmosValidatorsTag).Inc()
		fmt.Printf("[cosmos-hub] validators err: %v\n", err)
		return
	}

	atomPrice, err := fetchCosmosPrice(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(cosmosChain, coingeckoAtomSourceTag).Inc()
		fmt.Printf("[cosmos-hub] coingecko err (stake_usd will be skipped): %v\n", err)
		atomPrice = 0
	}

	// Sort by tokens desc, cap top-N.
	sort.Slice(validators, func(i, j int) bool {
		return parseFloat(validators[i].Tokens) > parseFloat(validators[j].Tokens)
	})
	if len(validators) > cosmosTopN {
		validators = validators[:cosmosTopN]
	}

	networkAPR := inflation * (1 - cosmosCommunityTax) / bondedRatio
	grossBps := pctToBps(networkAPR)

	const uatomPerAtom = 1e6

	netYields := make([]float64, 0, len(validators))
	for _, v := range validators {
		name := shortenName(v.Description.Moniker)
		id := v.OperatorAddress

		commissionRate := parseFloat(v.Commission.CommissionRates.Rate) // 0..1
		if commissionRate < 0 {
			commissionRate = 0
		}
		if commissionRate > 1 {
			commissionRate = 1
		}
		commissionBps := commissionRate * 10000

		uptimePct := 100.0
		netBps := grossBps * (1 - commissionRate) * (uptimePct / 100)
		if v.Jailed {
			netBps = 0
		}

		stakeAtom := parseFloat(v.Tokens) / uatomPerAtom
		stakeUSD := stakeAtom * atomPrice

		jailed := 0.0
		if v.Jailed {
			jailed = 1
		}

		validatorNetYieldBps.WithLabelValues(cosmosChain, id, name).Set(netBps)
		validatorGrossYieldBps.WithLabelValues(cosmosChain, id, name).Set(grossBps)
		validatorMevShareBps.WithLabelValues(cosmosChain, id, name).Set(0)
		validatorCommissionBps.WithLabelValues(cosmosChain, id, name).Set(commissionBps)
		validatorUptimePct.WithLabelValues(cosmosChain, id, name).Set(uptimePct)
		if atomPrice > 0 {
			validatorStakeUSD.WithLabelValues(cosmosChain, id, name).Set(stakeUSD)
		}
		validatorJailed.WithLabelValues(cosmosChain, id, name).Set(jailed)

		netYields = append(netYields, netBps)
	}

	chainTotalValidators.WithLabelValues(cosmosChain).Set(float64(len(netYields)))
	chainMedianNetYieldBps.WithLabelValues(cosmosChain).Set(medianBps(netYields))
	lastScrapeTimestamp.WithLabelValues(cosmosChain).Set(float64(time.Now().Unix()))

	fmt.Printf("[cosmos-hub] published %d validators, median net yield %.0f bps, inflation=%.2f%%, bonded=%.1f%%, ATOM=$%.4f\n",
		len(netYields), medianBps(netYields), inflation*100, bondedRatio*100, atomPrice)
}
