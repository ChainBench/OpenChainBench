package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// LighterNativeSource hits Lighter's public mainnet info endpoints:
//
//	GET https://mainnet.zklighter.elliot.ai/api/v1/exchangeStats
//	GET https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails
//
// /exchangeStats does NOT directly expose a clean cohort-level
// volume_24h_usd field at the venue level today; the populated source
// of 24h dollar volume is the per-market order_book_stats array, which
// we sum. The same array is the source for the top-market figure.
//
// /orderBookDetails returns one row per perp market with an
// `open_interest` field (base units) and `last_trade_price` (USD).
// We sum open_interest * last_trade_price across active markets for
// the OI gauge. active_markets is the count of markets with
// `status=="active"`.
type LighterNativeSource struct {
	client *http.Client
	venue  string
	base   string
	name   string
	// classify hands the perp symbols to the router's cross-venue
	// classification (the Robinhood deployment lists equities next to
	// tokens and has no asset class); mainnet keeps Mobula's taxonomy.
	classify bool
}

func NewLighterNativeSource() *LighterNativeSource {
	return NewLighterDeploymentSource("lighter", "https://mainnet.zklighter.elliot.ai/api/v1", srcLighterNative)
}

// NewLighterDeploymentSource reads one Lighter deployment. Lighter runs
// the same API on separate hosts per deployment (mainnet, and the
// Robinhood-branded api.rh.lighter.xyz since 2026), each with its own
// order books and volume.
func NewLighterDeploymentSource(venue, base, name string) *LighterNativeSource {
	return &LighterNativeSource{
		client:   &http.Client{Timeout: 15 * time.Second},
		venue:    venue,
		base:     base,
		name:     name,
		classify: venue != "lighter",
	}
}

func (s *LighterNativeSource) Name() string { return s.name }

type lighterExchangeStats struct {
	Code           int                  `json:"code"`
	Total          int                  `json:"total"`
	OrderBookStats []lighterMarketStats `json:"order_book_stats"`
}

type lighterMarketStats struct {
	Symbol                string  `json:"symbol"`
	LastTradePrice        float64 `json:"last_trade_price"`
	DailyTradesCount      float64 `json:"daily_trades_count"`
	DailyQuoteTokenVolume float64 `json:"daily_quote_token_volume"`
	DailyBaseTokenVolume  float64 `json:"daily_base_token_volume"`
}

type lighterOrderBookDetails struct {
	Code             int                      `json:"code"`
	OrderBookDetails []lighterOrderBookDetail `json:"order_book_details"`
}

type lighterOrderBookDetail struct {
	Symbol         string  `json:"symbol"`
	MarketType     string  `json:"market_type"`
	Status         string  `json:"status"`
	OpenInterest   float64 `json:"open_interest"`
	LastTradePrice float64 `json:"last_trade_price"`
}

func (s *LighterNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := s.venue

	// Pass 1: /exchangeStats for 24h volume + top-market volume.
	body, err := s.get(s.base + "/exchangeStats")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, s.name, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err exchangeStats: %v\n", venue, s.name, err)
	} else {
		var es lighterExchangeStats
		if err := json.Unmarshal(body, &es); err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, s.name, "parse").Inc()
			fmt.Printf("[perp-cohort][%s][%s] err parse exchangeStats: %v\n", venue, s.name, err)
		} else {
			var volSum, topVol float64
			for _, m := range es.OrderBookStats {
				volSum += m.DailyQuoteTokenVolume
				if m.DailyQuoteTokenVolume > topVol {
					topVol = m.DailyQuoteTokenVolume
				}
			}
			res.SetIfPositive(venue, mVolume24h, volSum)
			res.SetIfPositive(venue, mTopVol24h, topVol)
			fmt.Printf("[perp-cohort][%s][%s] ok exchangeStats: markets=%d vol24h=%.0f top24h=%.0f\n",
				venue, s.name, len(es.OrderBookStats), volSum, topVol)
		}
	}

	// Pass 2: /orderBookDetails for OI sum + active market count.
	body2, err := s.get(s.base + "/orderBookDetails")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, s.name, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err orderBookDetails: %v\n", venue, s.name, err)
	} else {
		var ob lighterOrderBookDetails
		if err := json.Unmarshal(body2, &ob); err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, s.name, "parse").Inc()
			fmt.Printf("[perp-cohort][%s][%s] err parse orderBookDetails: %v\n", venue, s.name, err)
		} else {
			var oiSum float64
			var active int
			var syms []string
			for _, m := range ob.OrderBookDetails {
				if m.MarketType != "perp" || m.Status != "active" {
					continue
				}
				active++
				oiSum += m.OpenInterest * m.LastTradePrice
				syms = append(syms, baseSymbol(m.Symbol))
			}
			res.SetIfPositive(venue, mOI, oiSum)
			res.SetIfPositive(venue, mActiveMarkets, float64(active))
			if s.classify {
				res.SetUnclassified(venue, syms)
			}
			fmt.Printf("[perp-cohort][%s][%s] ok orderBookDetails: active=%d oi=%.0f\n",
				venue, s.name, active, oiSum)
		}
	}

	return res, nil
}

func (s *LighterNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

// unused but kept for the parse helpers in case the API changes shape.
var _ = strconv.ParseFloat
