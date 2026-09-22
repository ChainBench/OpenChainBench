package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// ExtendedNativeSource calls the Extended (formerly X10) Starknet
// gateway:
//
//	GET https://api.starknet.extended.exchange/api/v1/info/markets
//
// The response is a single envelope: `{ "status": "OK", "data": [...] }`
// with one row per market. Each PERPETUAL row exposes the rollup
// fields under `marketStats`:
//
//	dailyVolume        (USD notional, string)
//	openInterest       (USD notional, string)
//	openInterestBase   (BASE units, string)
//	markPrice          (USD, string)
//	indexPrice         (USD, string)
//
// Only one HTTP call covers volume + OI + active count + top market,
// which keeps the per-tick fan-out at a single request.
//
// Derived metrics:
//
//	volume_24h_usd            = sum(dailyVolume) over ACTIVE perp rows
//	oi_usd                    = sum(openInterest) over ACTIVE perp rows
//	active_markets            = count(active PERPETUAL rows with markPrice > 0)
//	top_market_volume_24h_usd = max(dailyVolume)
type ExtendedNativeSource struct {
	client *http.Client
}

func NewExtendedNativeSource() *ExtendedNativeSource {
	return &ExtendedNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *ExtendedNativeSource) Name() string { return srcExtendedNative }

type extendedMarketStats struct {
	DailyVolume  string `json:"dailyVolume"`
	OpenInterest string `json:"openInterest"`
	MarkPrice    string `json:"markPrice"`
}

type extendedMarket struct {
	Name        string              `json:"name"`
	Type        string              `json:"type"`
	Status      string              `json:"status"`
	Category    string              `json:"category"`    // Crypto | RWA
	SubCategory string              `json:"subCategory"` // RWA: Equity, Commodity, FX, ETF/Index, Pre-market
	MarketStats extendedMarketStats `json:"marketStats"`
}

// extendedClass maps Extended's own market taxonomy onto the breadth
// classes. ETF/Index is split per symbol (SPX500m, JP225 and KR200 are
// indices, EWY or SOXL are listed ETFs); Pre-market is a pre-IPO equity
// synthetic; a Crypto-category commodity (PAXG) stays crypto.
func extendedClass(m extendedMarket) string {
	if m.Category != "RWA" {
		return classCrypto
	}
	switch m.SubCategory {
	case "Commodity":
		return classCommodities
	case "FX":
		return classForex
	case "ETF/Index":
		return rwaClass(baseSymbol(m.Name))
	}
	return classStocks
}

type extendedResponse struct {
	Status string           `json:"status"`
	Data   []extendedMarket `json:"data"`
}

func (s *ExtendedNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "extended"

	body, err := s.get("https://api.starknet.extended.exchange/api/v1/info/markets")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcExtendedNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcExtendedNative, err)
		return res, nil
	}

	var parsed extendedResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcExtendedNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse: %v\n", venue, srcExtendedNative, err)
		return res, nil
	}

	var volSum, oiSum, topVol float64
	var active int
	breadth := breadthCounter{}
	for _, m := range parsed.Data {
		if m.Type != "PERPETUAL" || m.Status != "ACTIVE" {
			continue
		}
		mark, _ := strconv.ParseFloat(m.MarketStats.MarkPrice, 64)
		if mark <= 0 {
			continue
		}
		active++
		class := extendedClass(m)
		breadth.add(class)
		if class == classCrypto {
			res.AddCryptoSymbol(baseSymbol(m.Name))
		} else {
			res.AddRWASymbol(baseSymbol(m.Name))
		}
		v, _ := strconv.ParseFloat(m.MarketStats.DailyVolume, 64)
		volSum += v
		if v > topVol {
			topVol = v
		}
		// openInterest on Extended is already USD-quoted (verified live
		// against the dashboard: BTC OI string matches the dollar value
		// shown in the UI), so no base*mark multiplication.
		oi, _ := strconv.ParseFloat(m.MarketStats.OpenInterest, 64)
		oiSum += oi
	}

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	res.SetBreadth(venue, breadth)
	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d vol24h=%.0f oi=%.0f top24h=%.0f breadth: %s\n",
		venue, srcExtendedNative, active, volSum, oiSum, topVol, breadth)
	return res, nil
}

func (s *ExtendedNativeSource) get(url string) ([]byte, error) {
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
