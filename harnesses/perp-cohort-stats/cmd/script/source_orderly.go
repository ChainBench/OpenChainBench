package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// OrderlyNativeSource queries the Orderly Network EVM public stats endpoint for
// 24h rolling perp taker notional volume.
//
// Endpoint: GET https://api-evm.orderly.org/v1/public/volume/stats
//
// Response shape:
//
//	{ "success": true, "data": {
//	    "perp_volume_last_1_day": 35903613.58,  // rolling 24h USD notional
//	    "perp_volume_today":      28154544.12,   // calendar-day UTC
//	    ...
//	  }}
//
// We use perp_volume_last_1_day as the canonical 24h rolling figure.
// Orderly is a cross-chain CLOB protocol (EVM chains: Arbitrum, Base, Optimism,
// Mantle, etc.) providing unified orderbook infrastructure for multiple frontends.
type OrderlyNativeSource struct {
	client *http.Client
}

func NewOrderlyNativeSource() *OrderlyNativeSource {
	return &OrderlyNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *OrderlyNativeSource) Name() string { return srcOrderlyNative }

type orderlyVolumeResp struct {
	Success bool `json:"success"`
	Data    struct {
		PerpVolumeLastDay float64 `json:"perp_volume_last_1_day"`
		PerpVolumeToday   float64 `json:"perp_volume_today"`
	} `json:"data"`
}

func (s *OrderlyNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "orderly"

	body, err := s.get("https://api-evm.orderly.org/v1/public/volume/stats")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcOrderlyNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcOrderlyNative, err)
		return res, nil
	}

	var resp orderlyVolumeResp
	if err := json.Unmarshal(body, &resp); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcOrderlyNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] parse err: %v\n", venue, srcOrderlyNative, err)
		return res, nil
	}

	if !resp.Success {
		perpCohortFetchErrors.WithLabelValues(venue, srcOrderlyNative, "api_error").Inc()
		fmt.Printf("[perp-cohort][%s][%s] api returned success=false\n", venue, srcOrderlyNative)
		return res, nil
	}

	vol := resp.Data.PerpVolumeLastDay
	if vol > 0 {
		res.SetIfPositive(venue, mVolume24h, vol)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f USD (today=%.0f)\n",
			venue, srcOrderlyNative, vol, resp.Data.PerpVolumeToday)
	}
	return res, nil
}

func (s *OrderlyNativeSource) get(url string) ([]byte, error) {
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
