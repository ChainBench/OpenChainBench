package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var _ = time.Second // keep time import for http.Client.Timeout

// KiloExNativeSource queries CoinGecko's public derivatives-exchange list for
// KiloEx across three chains: BSC, Base and opBNB.
//
// KiloEx is an oracle-based AMM perp DEX where traders open positions against
// a shared liquidity pool (counterparty model). Deployed on multiple chains.
//
// CoinGecko exchange IDs: "kiloex-bsc", "kiloex-base", "kiloex-opbnb"
// Endpoint: GET https://api.coingecko.com/api/v3/derivatives/exchanges?per_page=250
//
// We fetch the bulk list (single request) and sum trade_volume_24h_btc for
// the three KiloEx chain entries, then multiply by BTC/USD from Hyperliquid:
//
//	volume_24h_usd = sum(per_chain_btc) * btc_usd
type KiloExNativeSource struct {
	client *http.Client
}

func NewKiloExNativeSource() *KiloExNativeSource {
	return &KiloExNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *KiloExNativeSource) Name() string { return srcKiloExNative }

var kiloexChainIDs = map[string]bool{
	"kiloex-bsc":   true,
	"kiloex-base":  true,
	"kiloex-opbnb": true,
}

type cgExchangeListItem struct {
	ID                string  `json:"id"`
	TradeVolume24hBTC float64 `json:"trade_volume_24h_btc,string"`
}

func (s *KiloExNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "kiloex"

	btcPrice, err := s.fetchBTCPrice()
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcKiloExNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] btc price err: %v\n", venue, srcKiloExNative, err)
		return res, nil
	}

	// Bulk request: one call covers all KiloEx chain entries.
	body, err := s.get("https://api.coingecko.com/api/v3/derivatives/exchanges?per_page=250&page=1")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcKiloExNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] bulk err: %v\n", venue, srcKiloExNative, err)
		return res, nil
	}

	var exchanges []cgExchangeListItem
	if err := json.Unmarshal(body, &exchanges); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcKiloExNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] parse err: %v\n", venue, srcKiloExNative, err)
		return res, nil
	}

	var totalBTC float64
	for _, ex := range exchanges {
		if kiloexChainIDs[ex.ID] {
			fmt.Printf("[perp-cohort][%s][%s] chain=%s vol=%.2f BTC\n", venue, srcKiloExNative, ex.ID, ex.TradeVolume24hBTC)
			totalBTC += ex.TradeVolume24hBTC
		}
	}

	if totalBTC > 0 && btcPrice > 0 {
		volUSD := totalBTC * btcPrice
		res.SetIfPositive(venue, mVolume24h, volUSD)
		fmt.Printf("[perp-cohort][%s][%s] ok: total=%.2f BTC * %.0f = %.0f USD\n",
			venue, srcKiloExNative, totalBTC, btcPrice, volUSD)
	}
	return res, nil
}

func (s *KiloExNativeSource) fetchBTCPrice() (float64, error) {
	req, _ := http.NewRequest("POST", "https://api.hyperliquid.xyz/info", strings.NewReader(`{"type":"allMids"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var mids hlAllMidsResp
	if err := json.Unmarshal(body, &mids); err != nil {
		return 0, fmt.Errorf("parse hl allMids: %w", err)
	}
	priceStr, ok := mids["BTC"]
	if !ok {
		return 0, fmt.Errorf("BTC not in hl allMids")
	}
	var price float64
	if _, err := fmt.Sscanf(priceStr, "%f", &price); err != nil {
		return 0, fmt.Errorf("parse btc price %q: %w", priceStr, err)
	}
	return price, nil
}

func (s *KiloExNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		snippet := string(body)
		if len(snippet) > 100 {
			snippet = snippet[:100]
		}
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, snippet)
	}
	return body, nil
}
