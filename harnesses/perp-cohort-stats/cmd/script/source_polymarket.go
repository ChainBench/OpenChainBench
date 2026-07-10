package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// PolymarketNativeSource hits the Polymarket perps public info API
// (launched 2026-07-08, Polygon settlement, pUSD collateral):
//
//	GET https://api.perpetuals.polymarket.com/v1/info/tickers      (mark, OI, funding)
//	GET https://api.perpetuals.polymarket.com/v1/info/statistics   (24h quote volume)
//	GET https://api.perpetuals.polymarket.com/v1/info/instruments  (catalog)
//
// All endpoints are no-auth; the whole sweep is 3 requests (10
// instruments as of launch). Matching is off-chain so the REST API is
// the canonical data source.
//
// Derived metrics:
//
//	volume_24h_usd            = sum(statistics.volume)   (quote notional)
//	oi_usd                    = sum(open_interest_base * mark_price)
//	active_markets            = count(instruments)
//	top_market_volume_24h_usd = max(statistics.volume)
//	funding (ETH/BTC/SOL)     = funding_rate per 1h interval -> bps over 24h
type PolymarketNativeSource struct {
	client *http.Client
}

func NewPolymarketNativeSource() *PolymarketNativeSource {
	return &PolymarketNativeSource{client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *PolymarketNativeSource) Name() string { return srcPolymarketNative }

const polymarketPerpsBase = "https://api.perpetuals.polymarket.com/v1/info"

type polymarketTicker struct {
	InstrumentID int    `json:"instrument_id"`
	Symbol       string `json:"symbol"`
	MarkPrice    string `json:"mark_price"`
	OpenInterest string `json:"open_interest"`
	FundingRate  string `json:"funding_rate"`
}

type polymarketStat struct {
	InstrumentID int    `json:"instrument_id"`
	Symbol       string `json:"symbol"`
	Volume       string `json:"volume"`
}

type polymarketInstrument struct {
	InstrumentID    int    `json:"instrument_id"`
	Symbol          string `json:"symbol"`
	BaseAsset       string `json:"base_asset"`
	FundingInterval string `json:"funding_interval"` // "1h"
}

func (s *PolymarketNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "polymarket"

	var tickers []polymarketTicker
	if err := s.getJSON(polymarketPerpsBase+"/tickers", &tickers); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcPolymarketNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err tickers: %v\n", venue, srcPolymarketNative, err)
		return res, nil
	}
	var stats []polymarketStat
	if err := s.getJSON(polymarketPerpsBase+"/statistics", &stats); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcPolymarketNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err statistics: %v\n", venue, srcPolymarketNative, err)
		return res, nil
	}
	var instruments []polymarketInstrument
	if err := s.getJSON(polymarketPerpsBase+"/instruments", &instruments); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcPolymarketNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err instruments: %v\n", venue, srcPolymarketNative, err)
		return res, nil
	}

	var volSum, topVol float64
	for _, st := range stats {
		v, _ := strconv.ParseFloat(st.Volume, 64)
		volSum += v
		topVol = math.Max(topVol, v)
	}

	var oiSum float64
	for _, t := range tickers {
		oi, _ := strconv.ParseFloat(t.OpenInterest, 64)
		mark, _ := strconv.ParseFloat(t.MarkPrice, 64)
		if oi > 0 && mark > 0 {
			oiSum += oi * mark
		}
	}

	// Funding for the cohort assets. funding_interval is 1h on every
	// instrument at launch; parse it anyway so a venue-side change to
	// 8h does not silently corrupt the 24h normalization.
	intervalH := map[int]float64{}
	for _, in := range instruments {
		h := 1.0
		if v, err := strconv.ParseFloat(strings.TrimSuffix(in.FundingInterval, "h"), 64); err == nil && v > 0 {
			h = v
		}
		intervalH[in.InstrumentID] = h
	}
	for _, t := range tickers {
		asset := strings.TrimSuffix(t.Symbol, "-USD")
		switch asset {
		case "ETH", "BTC", "SOL":
			rate, err := strconv.ParseFloat(t.FundingRate, 64)
			if err != nil {
				continue
			}
			h := intervalH[t.InstrumentID]
			if h <= 0 {
				h = 1
			}
			res.SetFunding(venue, asset, fundingPoint{
				Bps24h:        rate / h * 24 * 10000,
				IntervalHours: h,
			})
		}
	}

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(len(instruments)))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: markets=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcPolymarketNative, len(instruments), volSum, oiSum, topVol)
	return res, nil
}

func (s *PolymarketNativeSource) getJSON(url string, out any) error {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("status_%d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
