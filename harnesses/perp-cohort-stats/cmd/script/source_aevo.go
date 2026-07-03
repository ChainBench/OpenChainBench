package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// AevoNativeSource hits the CoinGecko-compatible aggregate endpoint:
//
//	GET https://api.aevo.xyz/coingecko-statistics?type=PERPETUAL
//
// The response is a flat array, one row per perp instrument
// (~210 markets). Each row exposes:
//
//	ticker_id        (e.g. "BTC-PERP")
//	target_volume    (USD notional 24h, string; matches the per-asset
//	                  statistics.daily_volume field exactly)
//	open_interest    (BASE units, string)
//	index_price      (USD, string)
//
// Derived metrics:
//
//	volume_24h_usd            = sum(target_volume)
//	oi_usd                    = sum(open_interest * index_price)
//	active_markets            = count(rows with index_price > 0)
//	top_market_volume_24h_usd = max(target_volume)
type AevoNativeSource struct {
	client *http.Client
}

func NewAevoNativeSource() *AevoNativeSource {
	return &AevoNativeSource{
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

func (s *AevoNativeSource) Name() string { return srcAevoNative }

type aevoRow struct {
	TickerID     string `json:"ticker_id"`
	TargetVolume string `json:"target_volume"`
	OpenInterest string `json:"open_interest"`
	IndexPrice   string `json:"index_price"`
}

func (s *AevoNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "aevo"

	body, err := s.get("https://api.aevo.xyz/coingecko-statistics?type=PERPETUAL")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcAevoNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcAevoNative, err)
		return res, nil
	}

	var rows []aevoRow
	if err := json.Unmarshal(body, &rows); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcAevoNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse: %v\n", venue, srcAevoNative, err)
		return res, nil
	}

	var volSum, oiSum, topVol float64
	var active int
	for _, r := range rows {
		px, _ := strconv.ParseFloat(r.IndexPrice, 64)
		if px <= 0 {
			continue
		}
		active++
		v, _ := strconv.ParseFloat(r.TargetVolume, 64)
		volSum += v
		if v > topVol {
			topVol = v
		}
		oiBase, _ := strconv.ParseFloat(r.OpenInterest, 64)
		oiSum += oiBase * px
	}

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcAevoNative, active, volSum, oiSum, topVol)
	return res, nil
}

func (s *AevoNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
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
