package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

const (
	suiChain              = "sui"
	suiApysSourceTag      = "sui_getValidatorsApy"
	suiSystemSourceTag    = "sui_getLatestSystemState"
	coingeckoSuiSourceTag = "coingecko_sui"
)

// Sui exposes a single JSON-RPC endpoint per fullnode. The public
// mainnet endpoint has no key requirement and no strict rate limit for
// low-QPS pollers.
var (
	suiRPCURL         = envDefault("VAL_ECON_SUI_RPC_URL", "https://fullnode.mainnet.sui.io:443")
	coingeckoSuiURL   = envDefault("VAL_ECON_COINGECKO_SUI_URL", "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd")
)

// suiRPCEnvelope is the standard JSON-RPC 2.0 wrapper.
type suiRPCEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// suiValidatorApy is one entry in `suix_getValidatorsApy.result.apys`.
// `apy` is a decimal fraction (0.0234 = 2.34%) already net of the
// validator's commission per Sui docs.
type suiValidatorApy struct {
	Address string  `json:"address"`
	APY     float64 `json:"apy"`
	Epoch   int64   `json:"epoch"`
}

type suiValidatorsApyResponse struct {
	Epoch string            `json:"epoch"`
	APYs  []suiValidatorApy `json:"apys"`
}

// suiActiveValidator mirrors the fields we care about from the
// `activeValidators` array in `suix_getLatestSuiSystemState`. All
// numeric-like fields come back as strings.
type suiActiveValidator struct {
	SuiAddress        string `json:"suiAddress"`
	Name              string `json:"name"`
	Description       string `json:"description"`
	CommissionRate    string `json:"commissionRate"`    // bps, e.g. "200" = 2%
	StakingPoolSuiBal string `json:"stakingPoolSuiBalance"` // MIST (1 SUI = 1e9 MIST)
	NextEpochStake    string `json:"nextEpochStake"`
}

type suiSystemStateResponse struct {
	Epoch            string               `json:"epoch"`
	ActiveValidators []suiActiveValidator `json:"activeValidators"`
}

func suiRPC(ctx context.Context, client *http.Client, method string, out any) error {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
		"params":  []any{},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, suiRPCURL, bytes.NewReader(body))
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
		return fmt.Errorf("sui rpc %s http %d: %s", method, resp.StatusCode, string(raw))
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var env suiRPCEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("sui rpc %s envelope parse: %w", method, err)
	}
	if env.Error != nil {
		return fmt.Errorf("sui rpc %s error %d: %s", method, env.Error.Code, env.Error.Message)
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return fmt.Errorf("sui rpc %s result parse: %w", method, err)
	}
	return nil
}

func fetchSuiValidatorsAPY(ctx context.Context, client *http.Client) (suiValidatorsApyResponse, error) {
	var out suiValidatorsApyResponse
	err := suiRPC(ctx, client, "suix_getValidatorsApy", &out)
	return out, err
}

func fetchSuiSystemState(ctx context.Context, client *http.Client) (suiSystemStateResponse, error) {
	var out suiSystemStateResponse
	err := suiRPC(ctx, client, "suix_getLatestSuiSystemState", &out)
	return out, err
}

func fetchSuiPrice(ctx context.Context, client *http.Client) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, coingeckoSuiURL, nil)
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
		return 0, fmt.Errorf("coingecko sui http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var payload map[string]map[string]float64
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, fmt.Errorf("coingecko sui parse: %w", err)
	}
	v, ok := payload["sui"]
	if !ok {
		return 0, fmt.Errorf("coingecko missing sui key")
	}
	price := v["usd"]
	if price <= 0 {
		return 0, fmt.Errorf("coingecko invalid sui price %f", price)
	}
	return price, nil
}

// scrapeSui publishes per-validator yield gauges for Sui. The apy field
// from `suix_getValidatorsApy` is already net of commission per Sui
// docs, so we use it as both gross (before uptime adjustment) and net
// (after uptime, which we can't measure per-validator without the
// per-epoch checkpoint history — we assume 100% for v1).
//
// MEV: Sui rewards are pure staking rewards (protocol emission), no
// MEV component surfaces to validators today.
func scrapeSui(ctx context.Context, client *http.Client) {
	apy, err := fetchSuiValidatorsAPY(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(suiChain, suiApysSourceTag).Inc()
		fmt.Printf("[sui] getValidatorsApy err: %v\n", err)
		return
	}

	state, err := fetchSuiSystemState(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(suiChain, suiSystemSourceTag).Inc()
		fmt.Printf("[sui] getLatestSuiSystemState err (metadata only, continuing): %v\n", err)
	}

	// Index active validators by address for enrichment.
	valMeta := make(map[string]suiActiveValidator, len(state.ActiveValidators))
	for _, v := range state.ActiveValidators {
		valMeta[v.SuiAddress] = v
	}

	suiPrice, err := fetchSuiPrice(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(suiChain, coingeckoSuiSourceTag).Inc()
		fmt.Printf("[sui] coingecko err (stake_usd will be skipped): %v\n", err)
		suiPrice = 0
	}

	const mistPerSui = 1e9

	netYields := make([]float64, 0, len(apy.APYs))
	for _, entry := range apy.APYs {
		meta := valMeta[entry.Address]
		name := shortenName(meta.Name)
		if name == "(unknown)" {
			// Fall back to a truncated address so operators are
			// distinguishable in Grafana even when metadata is missing.
			if len(entry.Address) > 16 {
				name = shortenName(entry.Address[:16])
			} else {
				name = shortenName(entry.Address)
			}
		}
		id := entry.Address

		grossBps := pctToBps(entry.APY)
		// Uptime — no direct field; assume 100%.
		uptimePct := 100.0
		netBps := grossBps * (uptimePct / 100)

		// Commission comes back as basis points already (e.g. "200" = 2%).
		commissionBps, _ := strconv.ParseFloat(meta.CommissionRate, 64)
		if commissionBps < 0 {
			commissionBps = 0
		}
		if commissionBps > 10000 {
			commissionBps = 10000
		}

		stakeMist, _ := strconv.ParseFloat(meta.StakingPoolSuiBal, 64)
		stakeSUI := stakeMist / mistPerSui
		stakeUSD := stakeSUI * suiPrice

		validatorNetYieldBps.WithLabelValues(suiChain, id, name).Set(netBps)
		validatorGrossYieldBps.WithLabelValues(suiChain, id, name).Set(grossBps)
		validatorMevShareBps.WithLabelValues(suiChain, id, name).Set(0)
		validatorCommissionBps.WithLabelValues(suiChain, id, name).Set(commissionBps)
		validatorUptimePct.WithLabelValues(suiChain, id, name).Set(uptimePct)
		if suiPrice > 0 {
			validatorStakeUSD.WithLabelValues(suiChain, id, name).Set(stakeUSD)
		}
		validatorJailed.WithLabelValues(suiChain, id, name).Set(0)

		netYields = append(netYields, netBps)
	}

	chainTotalValidators.WithLabelValues(suiChain).Set(float64(len(netYields)))
	chainMedianNetYieldBps.WithLabelValues(suiChain).Set(medianBps(netYields))
	lastScrapeTimestamp.WithLabelValues(suiChain).Set(float64(time.Now().Unix()))

	fmt.Printf("[sui] published %d validators, median net yield %.0f bps, SUI=$%.4f\n",
		len(netYields), medianBps(netYields), suiPrice)
}
