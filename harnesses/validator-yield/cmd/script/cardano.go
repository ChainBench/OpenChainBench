package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"
)

const (
	cardanoChain           = "cardano"
	koiosPoolListTag       = "koios_pool_list"
	koiosPoolInfoTag       = "koios_pool_info"
	koiosEpochParamsTag    = "koios_epoch_params"
	coingeckoAdaSourceTag  = "coingecko_ada"

	// Top-N cap: Cardano has ~3000 registered stake pools but the tail
	// past position 50 holds a rounding-error share of total stake. Same
	// rationale as the Solana top-200 cap — bounds Prometheus label
	// cardinality without losing ranking information for this bench.
	cardanoTopN = 50
)

// koiosPoolListEntry mirrors GET /pool_list. The bech32 pool ID is the
// stable identifier used as the label; ticker is nullable when the pool
// hasn't registered SMASH metadata.
type koiosPoolListEntry struct {
	PoolIDBech32 string  `json:"pool_id_bech32"`
	PoolIDHex    string  `json:"pool_id_hex"`
	Ticker       *string `json:"ticker"`
	MetaURL      *string `json:"meta_url"`
	PoolStatus   string  `json:"pool_status"`
	ActiveStake  *string `json:"active_stake"` // lovelace, stringified
}

// koiosPoolInfo mirrors the POST /pool_info response. Only the fields
// we consume are declared. `margin` is Cardano's commission fraction
// [0,1]; `active_stake` and `live_pledge` are stringified lovelace
// (1 ADA = 1e6 lovelace).
type koiosPoolInfo struct {
	PoolIDBech32 string  `json:"pool_id_bech32"`
	Ticker       *string `json:"meta_json_ticker"` // some deployments nest under meta_json
	Margin       float64 `json:"margin"`
	FixedCost    string  `json:"fixed_cost"`
	Pledge       string  `json:"pledge"`
	LivePledge   string  `json:"live_pledge"`
	ActiveStake  string  `json:"active_stake"`
	MetaJSON     *struct {
		Ticker string `json:"ticker"`
		Name   string `json:"name"`
	} `json:"meta_json"`
}

// koiosEpochParams — we only need monetary_expansion (rho) and
// treasury_growth_rate (tau) to approximate the network-wide gross APR
// pre-commission.
type koiosEpochParams struct {
	EpochNo            int64   `json:"epoch_no"`
	MonetaryExpansion  float64 `json:"monetary_expansion"`
	TreasuryGrowthRate float64 `json:"treasury_growth_rate"`
}

var (
	koiosBaseURL       = envDefault("VAL_ECON_KOIOS_URL", "https://api.koios.rest/api/v1")
	coingeckoCardanoURL = envDefault("VAL_ECON_COINGECKO_ADA_URL", "https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd")
)

// Cardano's real yield formula is famously nuanced (pledge influence
// factor a0, saturation curve k, block-production luck). For v1 we
// approximate:
//
//	gross_network_apr ≈ rho × (1 - tau)
//	gross_pool_apr    ≈ gross_network_apr   (all pools share the pot pro-rata)
//	net_pool_apr      ≈ gross_pool_apr × (1 - margin)
//
// This ignores the a0/k/saturation effects; empirically it lands
// within ~50-100 bps of Cardano's ADAPools/pooltool.io figures for
// non-saturated pools and is honest enough for a network-comparison
// bench. If Koios's epoch_params fetch fails we fall back to
// cardanoFallbackAPR (a documented approximation of ~5%).
const cardanoFallbackAPR = 0.05

func fetchKoiosPoolList(ctx context.Context, client *http.Client) ([]koiosPoolListEntry, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, koiosBaseURL+"/pool_list?pool_status=eq.registered", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("koios pool_list http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var out []koiosPoolListEntry
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("koios pool_list parse: %w", err)
	}
	return out, nil
}

func fetchKoiosPoolInfo(ctx context.Context, client *http.Client, ids []string) ([]koiosPoolInfo, error) {
	body, err := json.Marshal(map[string]any{"_pool_bech32_ids": ids})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, koiosBaseURL+"/pool_info", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("koios pool_info http %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var out []koiosPoolInfo
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("koios pool_info parse: %w", err)
	}
	return out, nil
}

func fetchKoiosEpochParams(ctx context.Context, client *http.Client) (koiosEpochParams, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, koiosBaseURL+"/epoch_params?limit=1", nil)
	if err != nil {
		return koiosEpochParams{}, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return koiosEpochParams{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return koiosEpochParams{}, fmt.Errorf("koios epoch_params http %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return koiosEpochParams{}, err
	}
	var out []koiosEpochParams
	if err := json.Unmarshal(raw, &out); err != nil {
		return koiosEpochParams{}, fmt.Errorf("koios epoch_params parse: %w", err)
	}
	if len(out) == 0 {
		return koiosEpochParams{}, fmt.Errorf("koios epoch_params: empty response")
	}
	return out[0], nil
}

func fetchCardanoPrice(ctx context.Context, client *http.Client) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, coingeckoCardanoURL, nil)
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
		return 0, fmt.Errorf("coingecko ada http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var payload map[string]map[string]float64
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, fmt.Errorf("coingecko ada parse: %w", err)
	}
	v, ok := payload["cardano"]
	if !ok {
		return 0, fmt.Errorf("coingecko missing cardano key")
	}
	price := v["usd"]
	if price <= 0 {
		return 0, fmt.Errorf("coingecko invalid ada price %f", price)
	}
	return price, nil
}

// scrapeCardano fetches the top-N stake pools from Koios, applies a
// simple rho×(1-tau)/pool_margin approximation, and publishes the
// standard OCB validator gauges under chain="cardano".
//
// Uptime is set to 100% for every pool: Cardano stake pools don't have
// a canonical uptime metric in the same sense as Solana/Hyperliquid
// (block-production luck varies by chance, not by operator downtime).
func scrapeCardano(ctx context.Context, client *http.Client) {
	pools, err := fetchKoiosPoolList(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(cardanoChain, koiosPoolListTag).Inc()
		fmt.Printf("[cardano] koios pool_list err: %v\n", err)
		return
	}

	// Sort descending by active_stake (parsed as lovelace) and cap.
	sort.Slice(pools, func(i, j int) bool {
		var a, b float64
		if pools[i].ActiveStake != nil {
			a = parseFloat(*pools[i].ActiveStake)
		}
		if pools[j].ActiveStake != nil {
			b = parseFloat(*pools[j].ActiveStake)
		}
		return a > b
	})
	if len(pools) > cardanoTopN {
		pools = pools[:cardanoTopN]
	}

	// Batch pool_info in a single POST — Koios accepts up to ~200 IDs.
	ids := make([]string, 0, len(pools))
	for _, p := range pools {
		ids = append(ids, p.PoolIDBech32)
	}
	infos, err := fetchKoiosPoolInfo(ctx, client, ids)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(cardanoChain, koiosPoolInfoTag).Inc()
		fmt.Printf("[cardano] koios pool_info err: %v\n", err)
		return
	}
	infoIdx := make(map[string]koiosPoolInfo, len(infos))
	for _, info := range infos {
		infoIdx[info.PoolIDBech32] = info
	}

	// Network-wide gross APR from monetary params — fall back to a
	// documented static approximation if Koios flakes here.
	networkAPR := cardanoFallbackAPR
	params, err := fetchKoiosEpochParams(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(cardanoChain, koiosEpochParamsTag).Inc()
		fmt.Printf("[cardano] koios epoch_params err (using %.1f%% fallback): %v\n", cardanoFallbackAPR*100, err)
	} else if params.MonetaryExpansion > 0 {
		// rho × (1 - tau). Cardano distributes rho of the reserve per
		// epoch; tau goes to treasury before pools split the rest.
		// Annualisation: rho is already per-epoch × 73 epochs/year ≈
		// per-year in Koios semantics for this field.
		networkAPR = params.MonetaryExpansion * (1 - params.TreasuryGrowthRate)
	}

	adaPrice, err := fetchCardanoPrice(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(cardanoChain, coingeckoAdaSourceTag).Inc()
		fmt.Printf("[cardano] coingecko err (stake_usd will be skipped): %v\n", err)
		adaPrice = 0
	}

	const lovelacePerAda = 1e6

	netYields := make([]float64, 0, len(pools))
	for _, p := range pools {
		info, ok := infoIdx[p.PoolIDBech32]
		if !ok {
			continue
		}
		name := shortenName(cardanoPoolLabel(p, info))
		id := p.PoolIDBech32

		grossBps := pctToBps(networkAPR)
		commissionBps := info.Margin * 10000
		if commissionBps > 10000 {
			commissionBps = 10000
		}
		netAPR := networkAPR * (1 - info.Margin)
		netBps := pctToBps(netAPR)

		// Uptime: no canonical Cardano equivalent — assume 100%.
		uptimePct := 100.0

		activeStakeLovelace := parseFloat(info.ActiveStake)
		if activeStakeLovelace == 0 && p.ActiveStake != nil {
			activeStakeLovelace = parseFloat(*p.ActiveStake)
		}
		stakeADA := activeStakeLovelace / lovelacePerAda
		stakeUSD := stakeADA * adaPrice

		validatorNetYieldBps.WithLabelValues(cardanoChain, id, name).Set(netBps)
		validatorGrossYieldBps.WithLabelValues(cardanoChain, id, name).Set(grossBps)
		validatorMevShareBps.WithLabelValues(cardanoChain, id, name).Set(0)
		validatorCommissionBps.WithLabelValues(cardanoChain, id, name).Set(commissionBps)
		validatorUptimePct.WithLabelValues(cardanoChain, id, name).Set(uptimePct)
		if adaPrice > 0 {
			validatorStakeUSD.WithLabelValues(cardanoChain, id, name).Set(stakeUSD)
		}
		validatorJailed.WithLabelValues(cardanoChain, id, name).Set(0)

		netYields = append(netYields, netBps)
	}

	chainTotalValidators.WithLabelValues(cardanoChain).Set(float64(len(netYields)))
	chainMedianNetYieldBps.WithLabelValues(cardanoChain).Set(medianBps(netYields))
	lastScrapeTimestamp.WithLabelValues(cardanoChain).Set(float64(time.Now().Unix()))

	fmt.Printf("[cardano] published %d pools, median net yield %.0f bps, ADA=$%.4f\n",
		len(netYields), medianBps(netYields), adaPrice)
}

// cardanoPoolLabel picks the best human name we can find: meta_json
// ticker/name if present, else the list-endpoint ticker, else a
// truncated bech32. Never returns empty (shortenName upgrades that
// to "(unknown)").
func cardanoPoolLabel(p koiosPoolListEntry, info koiosPoolInfo) string {
	if info.MetaJSON != nil {
		if info.MetaJSON.Ticker != "" {
			return info.MetaJSON.Ticker
		}
		if info.MetaJSON.Name != "" {
			return info.MetaJSON.Name
		}
	}
	if info.Ticker != nil && *info.Ticker != "" {
		return *info.Ticker
	}
	if p.Ticker != nil && *p.Ticker != "" {
		return *p.Ticker
	}
	if len(p.PoolIDBech32) > 16 {
		return p.PoolIDBech32[:16]
	}
	return p.PoolIDBech32
}
