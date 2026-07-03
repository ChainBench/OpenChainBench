package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// DydxNativeSource calls the v4 indexer:
//
//	GET https://indexer.dydx.trade/v4/perpetualMarkets
//
// Response shape: { "markets": { "BTC-USD": { ... }, "ETH-USD": {...}, ... } }.
// Each market exposes:
//
//	status            ("ACTIVE" / "FINAL_SETTLEMENT" / "PAUSED" / ...)
//	volume24H         (USD notional, string)
//	openInterest      (BASE units, string)
//	oraclePrice       (USD, string)
//
// Derived metrics:
//
//	volume_24h_usd            = sum(volume24H) over ACTIVE markets
//	oi_usd                    = sum(openInterest * oraclePrice) over ACTIVE markets
//	active_markets            = count(status == "ACTIVE")
//	top_market_volume_24h_usd = max(volume24H) over ACTIVE markets
type DydxNativeSource struct {
	client *http.Client
}

func NewDydxNativeSource() *DydxNativeSource {
	return &DydxNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *DydxNativeSource) Name() string { return srcDydxNative }

type dydxMarket struct {
	Status       string `json:"status"`
	Volume24H    string `json:"volume24H"`
	OpenInterest string `json:"openInterest"`
	OraclePrice  string `json:"oraclePrice"`
}

type dydxResponse struct {
	Markets map[string]dydxMarket `json:"markets"`
}

func (s *DydxNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "dydx"

	body, err := s.get("https://indexer.dydx.trade/v4/perpetualMarkets")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcDydxNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcDydxNative, err)
		return res, nil
	}

	var parsed dydxResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcDydxNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse: %v\n", venue, srcDydxNative, err)
		return res, nil
	}

	var volSum, oiSum, topVol float64
	var active int
	for _, m := range parsed.Markets {
		if m.Status != "ACTIVE" {
			continue
		}
		active++
		v, _ := strconv.ParseFloat(m.Volume24H, 64)
		volSum += v
		if v > topVol {
			topVol = v
		}
		oi, _ := strconv.ParseFloat(m.OpenInterest, 64)
		px, _ := strconv.ParseFloat(m.OraclePrice, 64)
		oiSum += oi * px
	}

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcDydxNative, active, volSum, oiSum, topVol)
	return res, nil
}

func (s *DydxNativeSource) get(url string) ([]byte, error) {
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
