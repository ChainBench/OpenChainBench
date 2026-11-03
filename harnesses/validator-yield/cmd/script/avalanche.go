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
)

const (
	avalancheChain         = "avalanche"
	avalancheValidatorsTag = "avax_platform_getCurrentValidators"

	// Cap: Avalanche has ~1500 primary-network validators. Top 100 by
	// stake covers the vast majority of delegated AVAX and keeps
	// Prometheus cardinality bounded.
	avalancheTopN = 100

	// Gross APR per validator is READ from the P-Chain, not assumed:
	// platform.getCurrentValidators returns each validator's
	// potentialReward (nAVAX it earns at the end of its staking period
	// if uptime stays above 80%), its stake and its start/end times:
	//
	//	gross = potentialReward / stake × year / (endTime − startTime)
	//
	// That is the protocol reward function evaluated for the validator's
	// own stake, duration and the remaining supply at its start, so it
	// moves with the declining issuance and longer periods earn more.
	// Until 2026-11 the harness used a hard-coded 8.5% here; the live
	// median of the top 100 was 5.3% (2026-11-03).
)

var (
	avalanchePChainURL = envDefault("VAL_ECON_AVAX_PCHAIN_URL", "https://api.avax.network/ext/bc/P")
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
//   - stakeAmount:   nAVAX (1 AVAX = 1e9 nAVAX)
//   - delegationFee: percentage string, e.g. "2.0000" = 2%
//   - uptime:        fractional string in [0,1] on newer avalanchego,
//     older nodes returned percent [0,100] — normalise both.
type avaxValidator struct {
	NodeID          string `json:"nodeID"`
	StakeAmount     string `json:"stakeAmount"`
	Weight          string `json:"weight"` // some responses use weight instead of stakeAmount
	StartTime       string `json:"startTime"`
	EndTime         string `json:"endTime"`
	DelegationFee   string `json:"delegationFee"`
	PotentialReward string `json:"potentialReward"`
	Uptime          string `json:"uptime"`
	Connected       bool   `json:"connected"`
	Signer          *struct {
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

// avalancheGrossAPR annualizes a validator's potentialReward over its
// staking period. Units cancel (nAVAX / nAVAX); times are unix seconds.
func avalancheGrossAPR(potentialReward, stake, start, end float64) float64 {
	if stake <= 0 || end <= start {
		return 0
	}
	return potentialReward / stake * secondsPerYear / (end - start)
}

// scrapeAvalanche publishes per-validator gauges for the Avalanche
// primary network (P-Chain). Yield is computed from the on-chain gross
// APR (from potentialReward, see avalancheGrossAPR) adjusted by
// per-validator uptime and delegation fee.
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

	avaxPrice := priceUSD(ctx, client, avalancheChain, "avalanche-2")

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

	rows := make([]valRow, 0, len(validators))
	for _, v := range validators {
		uptimePct := parseAvaxUptime(v.Uptime)
		delegationFeePct := clamp(parseFloat(v.DelegationFee), 0, 100) // 0..100
		stakeNAvax := stakeOf(v)
		grossBps := pctToBps(avalancheGrossAPR(parseFloat(v.PotentialReward), stakeNAvax, parseFloat(v.StartTime), parseFloat(v.EndTime)))
		rows = append(rows, valRow{
			// The P-Chain response carries no human name: the nodeID
			// is the operator identity.
			ID: v.NodeID, Name: v.NodeID,
			GrossBps: grossBps, NetBps: grossBps * (uptimePct / 100) * (1 - delegationFeePct/100),
			CommissionBps: delegationFeePct * 100, UptimePct: uptimePct,
			StakeNative: stakeNAvax / nAvaxPerAvax,
		})
	}
	med := publishRows(avalancheChain, rows, avaxPrice)

	fmt.Printf("[avalanche] published %d validators, median net yield %.0f bps, AVAX=$%.4f\n",
		len(rows), med, avaxPrice)
}
