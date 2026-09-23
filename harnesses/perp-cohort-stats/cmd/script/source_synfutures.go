package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// SynFuturesNativeSource reads SynFutures (oAMM perp DEX on Base, Arbitrum
// and opBNB) from CoinGecko's derivatives-exchange list: the venue's own
// API (api.synfutures.com/v3) answers 403 to every unauthenticated path
// and its swagger endpoint 500s (checked 2026-09-22), so there is no
// native stats surface to read.
//
// CoinGecko exchange ID: "synfutures", row of the shared list in coingecko.go
//
// trade_volume_24h_btc is the 24h rolling taker notional expressed in BTC.
// A second call fetches the BTC/USD spot price from CoinGecko's simple/price
// endpoint, then:
//
//	volume_24h_usd = trade_volume_24h_btc * btc_usd
//
// No API key is required. Free-tier rate limit is ~10-30 req/min; the harness
// fires every 10 minutes, so two calls per tick are well within limits.
type SynFuturesNativeSource struct {
	client *http.Client
}

func NewSynFuturesNativeSource() *SynFuturesNativeSource {
	return &SynFuturesNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *SynFuturesNativeSource) Name() string { return srcSynFuturesNative }

// hlAllMidsResp is the Hyperliquid allMids response: map of coin -> mid price string.
type hlAllMidsResp map[string]string

func (s *SynFuturesNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "synfutures"

	btcPrice, err := s.fetchBTCPrice()
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcSynFuturesNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] btc price err: %v\n", venue, srcSynFuturesNative, err)
		return res, nil
	}

	// The exchange row comes from the shared, cached derivatives list
	// (coingecko.go) rather than a per-venue call every tick.
	volBTC, found, stale, err := cgVolume24hBTC(map[string]bool{"synfutures": true})
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcSynFuturesNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcSynFuturesNative, err)
		return res, nil
	}
	if stale {
		perpCohortFetchErrors.WithLabelValues(venue, srcSynFuturesNative, "stale_cache").Inc()
	}
	if found == 0 {
		perpCohortFetchErrors.WithLabelValues(venue, srcSynFuturesNative, "not_listed").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: synfutures absent from the CoinGecko top-250 list\n", venue, srcSynFuturesNative)
		return res, nil
	}

	if volBTC > 0 && btcPrice > 0 {
		volUSD := volBTC * btcPrice
		res.SetIfPositive(venue, mVolume24h, volUSD)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f BTC * %.0f USD/BTC = %.0f USD\n",
			venue, srcSynFuturesNative, volBTC, btcPrice, volUSD)
	}
	return res, nil
}

// fetchBTCPrice fetches the BTC mid price from Hyperliquid's allMids endpoint.
// This avoids CoinGecko rate limits since Hyperliquid is already queried by
// the harness and has no rate-limiting on the public info API.
func (s *SynFuturesNativeSource) fetchBTCPrice() (float64, error) {
	req, _ := http.NewRequest("POST", "https://api.hyperliquid.xyz/info", strings.NewReader(`{"type":"allMids"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
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

func (s *SynFuturesNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
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
