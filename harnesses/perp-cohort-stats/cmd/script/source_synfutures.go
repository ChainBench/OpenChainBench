package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// SynFuturesNativeSource queries CoinGecko's public derivatives-exchange endpoint
// for SynFutures, an oAMM-based perp DEX deployed on Base, Arbitrum and opBNB.
//
// CoinGecko exchange ID: "synfutures"
// Endpoint: GET https://api.coingecko.com/api/v3/derivatives/exchanges/synfutures
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

type cgDerivExchangeResp struct {
	TradeVolume24hBTC float64 `json:"trade_volume_24h_btc,string"`
}

type cgSimplePriceResp struct {
	Bitcoin struct {
		USD float64 `json:"usd"`
	} `json:"bitcoin"`
}

func (s *SynFuturesNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "synfutures"

	btcPrice, err := s.fetchBTCPrice()
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcSynFuturesNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] btc price err: %v\n", venue, srcSynFuturesNative, err)
		return res, nil
	}

	body, err := s.get("https://api.coingecko.com/api/v3/derivatives/exchanges/synfutures")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcSynFuturesNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcSynFuturesNative, err)
		return res, nil
	}

	var resp cgDerivExchangeResp
	if err := json.Unmarshal(body, &resp); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcSynFuturesNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] parse err: %v\n", venue, srcSynFuturesNative, err)
		return res, nil
	}

	if resp.TradeVolume24hBTC > 0 && btcPrice > 0 {
		volUSD := resp.TradeVolume24hBTC * btcPrice
		res.SetIfPositive(venue, mVolume24h, volUSD)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f BTC * %.0f USD/BTC = %.0f USD\n",
			venue, srcSynFuturesNative, resp.TradeVolume24hBTC, btcPrice, volUSD)
	}
	return res, nil
}

func (s *SynFuturesNativeSource) fetchBTCPrice() (float64, error) {
	body, err := s.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd")
	if err != nil {
		return 0, err
	}
	var resp cgSimplePriceResp
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, fmt.Errorf("parse btc price: %w", err)
	}
	return resp.Bitcoin.USD, nil
}

func (s *SynFuturesNativeSource) get(url string) ([]byte, error) {
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
