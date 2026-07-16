package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"time"
)

const (
	avalancheChain           = "avalanche"
	avalancheValidatorsTag   = "avax_platform_getCurrentValidators"
	coingeckoAvaxSourceTag   = "coingecko_avax"

	// Cap: Avalanche has ~1500 primary-network validators. Top 100 by
	// stake covers the vast majority of delegated AVAX and keeps
	// Prometheus cardinality bounded.
	avalancheTopN = 100

	// Avalanche P-Chain base staking reward is a documented ~8.5% APY
	// for a validator delegating for a full year at 100% uptime. The
	// P-Chain API doesn't publish a per-validator realised APR — the
	// number is deterministic given (stake, duration, uptime), and
	// duration doesn't materially move for long-running delegators.
	// v1 shortcut: use the documented base and adjust per-validator by
	// uptime × (1 - delegationFee/100). Real per-validator numbers vary
	// by ±20 bps due to duration-bonus differences; acceptable for a
	// network-comparison bench.
	avalancheBaseAPR = 0.085
)

var (
	avalanchePChainURL = envDefault("VAL_ECON_AVAX_PCHAIN_URL", "https://api.avax.network/ext/bc/P")
	coingeckoAvaxURL   = envDefault("VAL_ECON_COINGECKO_AVAX_URL", "https://api.coingecko.com/api/v3/simple/price?ids=avalanche-2&vs_currencies=usd")
)

// avaxRPCEnvelope wraps the JSON-RPC 2.0 response used by the P-Chain
// `platform` API.
type avaxRPCEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// avaxValidator mirrors the shape returned by
// platform.getCurrentValidators. Numeric fields come back as strings.
//
// - stakeAmount:   nAVAX (1 AVAX = 1e9 nAVAX)
// - delegationFee: percentage string, e.g. "2.0000" = 2%
// - uptime:        fractional string in [0,1] on newer avalanchego,
//                  older nodes returned percent [0,100] — normalise both.
type avaxValidator struct {
	NodeID        string `json:"nodeID"`
	StakeAmount   string `json:"stakeAmount"`
	Weight        string `json:"weight"` // some responses use weight instead of stakeAmount
	StartTime     string `json:"startTime"`
	EndTime       string `json:"endTime"`
	DelegationFee string `json:"delegationFee"`
	Uptime        string `json:"uptime"`
	Connected     bool   `json:"connected"`
	Signer        *struct {
		PublicKey string `json:"publicKey"`
	} `json:"signer"`
	Delegators any `json:"delegators"` // ignored — variable shape, blobs cause parse fights
}

type avaxCurrentValidatorsResult struct {
	Validators []avaxValidator `json:"validators"`
}

func avaxPChainRPC(ctx context.Context, client *http.Client, method string, params any, out any) error {
	if params == nil {
		params = map[string]any{}
	}
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
		"params":  params,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, avalanchePChainURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("avax pchain %s http %d: %s", method, resp.StatusCode, string(raw))
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var env avaxRPCEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("avax pchain %s envelope parse: %w", method, err)
	}
	if env.Error != nil {
		return fmt.Errorf("avax pchain %s error %d: %s", method, env.Error.Code, env.Error.Message)
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return fmt.Errorf("avax pchain %s result parse: %w", method, err)
	}
	return nil
}

func fetchAvalancheValidators(ctx context.Context, client *http.Client) ([]avaxValidator, error) {
	var out avaxCurrentValidatorsResult
	// Empty params returns primary network validators, all subnets excluded.
	err := avaxPChainRPC(ctx, client, "platform.getCurrentValidators", map[string]any{}, &out)
	return out.Validators, err
}

func fetchAvalanchePrice(ctx context.Context, client *http.Client) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, coingeckoAvaxURL, nil)
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
		return 0, fmt.Errorf("coingecko avax http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var payload map[string]map[string]float64
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, fmt.Errorf("coingecko avax parse: %w", err)
	}
	v, ok := payload["avalanche-2"]
	if !ok {
		return 0, fmt.Errorf("coingecko missing avalanche-2 key")
	}
	price := v["usd"]
	if price <= 0 {
		return 0, fmt.Errorf("coingecko invalid avax price %f", price)
	}
	return price, nil
}

// parseAvaxUptime normalises the uptime field returned by
// platform.getCurrentValidators. Newer nodes report it as a fractional
// value in [0,1] ("0.998"); older nodes returned a percent ("99.8").
// If the parsed value is >1 we treat it as a percent, else a fraction.
func parseAvaxUptime(s string) float64 {
	if s == "" {
		return 100.0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 100.0
	}
	if v <= 1.0 {
		v *= 100
	}
	if v < 0 {
		v = 0
	}
	if v > 100 {
		v = 100
	}
	return v
}

// scrapeAvalanche publishes per-validator gauges for the Avalanche
// primary network (P-Chain). Yield is computed from the documented base
// APR adjusted by per-validator uptime and delegation fee.
//
// stakeAmount / weight — we prefer stakeAmount but some node builds
// return weight instead; fall back if needed.
func scrapeAvalanche(ctx context.Context, client *http.Client) {
	validators, err := fetchAvalancheValidators(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(avalancheChain, avalancheValidatorsTag).Inc()
		fmt.Printf("[avalanche] getCurrentValidators err: %v\n", err)
		return
	}

	avaxPrice, err := fetchAvalanchePrice(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(avalancheChain, coingeckoAvaxSourceTag).Inc()
		fmt.Printf("[avalanche] coingecko err (stake_usd will be skipped): %v\n", err)
		avaxPrice = 0
	}

	// Sort by stake desc, cap top-N.
	stakeOf := func(v avaxValidator) float64 {
		if s := parseFloat(v.StakeAmount); s > 0 {
			return s
		}
		return parseFloat(v.Weight)
	}
	sort.Slice(validators, func(i, j int) bool {
		return stakeOf(validators[i]) > stakeOf(validators[j])
	})
	if len(validators) > avalancheTopN {
		validators = validators[:avalancheTopN]
	}

	const nAvaxPerAvax = 1e9
	grossBps := pctToBps(avalancheBaseAPR)

	netYields := make([]float64, 0, len(validators))
	for _, v := range validators {
		id := v.NodeID
		// Avalanche doesn't include a human name in the P-Chain
		// response — the nodeID is the operator identity.
		name := shortenName(id)

		uptimePct := parseAvaxUptime(v.Uptime)
		delegationFeePct := parseFloat(v.DelegationFee) // 0..100

		commissionBps := delegationFeePct * 100
		if commissionBps > 10000 {
			commissionBps = 10000
		}

		netBps := grossBps * (uptimePct / 100) * (1 - delegationFeePct/100)

		stakeNAvax := stakeOf(v)
		stakeAvax := stakeNAvax / nAvaxPerAvax
		stakeUSD := stakeAvax * avaxPrice

		validatorNetYieldBps.WithLabelValues(avalancheChain, id, name).Set(netBps)
		validatorGrossYieldBps.WithLabelValues(avalancheChain, id, name).Set(grossBps)
		validatorMevShareBps.WithLabelValues(avalancheChain, id, name).Set(0)
		validatorCommissionBps.WithLabelValues(avalancheChain, id, name).Set(commissionBps)
		validatorUptimePct.WithLabelValues(avalancheChain, id, name).Set(uptimePct)
		if avaxPrice > 0 {
			validatorStakeUSD.WithLabelValues(avalancheChain, id, name).Set(stakeUSD)
		}
		validatorJailed.WithLabelValues(avalancheChain, id, name).Set(0)

		netYields = append(netYields, netBps)
	}

	chainTotalValidators.WithLabelValues(avalancheChain).Set(float64(len(netYields)))
	chainMedianNetYieldBps.WithLabelValues(avalancheChain).Set(medianBps(netYields))
	lastScrapeTimestamp.WithLabelValues(avalancheChain).Set(float64(time.Now().Unix()))

	fmt.Printf("[avalanche] published %d validators, median net yield %.0f bps, AVAX=$%.4f\n",
		len(netYields), medianBps(netYields), avaxPrice)
}
