package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// GainsNativeSource queries the Gains Network (GNS) backend REST API for
// rolling 24h trading volume across Arbitrum and Polygon deployments.
//
// Endpoint:
//
//	GET https://backend-arbitrum.gains.trade/total-stats
//	GET https://backend-polygon.gains.trade/total-stats
//
// The response exposes protocol-level aggregate stats including the last 24h
// volume. Arbitrum and Polygon results are summed for the total cohort value.
//
// Derived metrics:
//
//	volume_24h_usd = lastDayVolume (arb) + lastDayVolume (polygon), in USD
type GainsNativeSource struct {
	client *http.Client
}

func NewGainsNativeSource() *GainsNativeSource {
	return &GainsNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *GainsNativeSource) Name() string { return srcGainsNative }

// gainsTotalStats covers multiple possible field names seen across GNS backend
// versions so the source stays resilient to minor API drift.
type gainsTotalStats struct {
	// v1 field names
	LastDayVolume  float64 `json:"lastDayVolume"`
	TotalVolumeUsd float64 `json:"totalVolumeUsd"`
	// v2 / alternative field names
	Volume24h     float64 `json:"volume24h"`
	VolumeUsd24h  float64 `json:"volumeUsd24h"`
	DailyVolumeUsd float64 `json:"dailyVolumeUsd"`
}

// vol24h returns the best-available 24h volume field from the parsed response.
func (g *gainsTotalStats) vol24h() float64 {
	if g.LastDayVolume > 0 {
		return g.LastDayVolume
	}
	if g.Volume24h > 0 {
		return g.Volume24h
	}
	if g.VolumeUsd24h > 0 {
		return g.VolumeUsd24h
	}
	if g.DailyVolumeUsd > 0 {
		return g.DailyVolumeUsd
	}
	return 0
}

func (s *GainsNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "gains"

	backends := []struct {
		chain string
		url   string
	}{
		{"arbitrum", "https://backend-arbitrum.gains.trade/total-stats"},
		{"polygon", "https://backend-polygon.gains.trade/total-stats"},
	}

	var totalVol float64
	anyOK := false
	for _, b := range backends {
		body, err := s.get(b.url)
		if err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcGainsNative, classifyError(err.Error())).Inc()
			fmt.Printf("[perp-cohort][%s][%s] err chain=%s: %v\n", venue, srcGainsNative, b.chain, err)
			continue
		}
		var stats gainsTotalStats
		if err := json.Unmarshal(body, &stats); err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcGainsNative, "parse").Inc()
			fmt.Printf("[perp-cohort][%s][%s] err parse chain=%s: %v\n", venue, srcGainsNative, b.chain, err)
			continue
		}
		v := stats.vol24h()
		fmt.Printf("[perp-cohort][%s][%s] ok: chain=%s vol24h=%.0f\n", venue, srcGainsNative, b.chain, v)
		totalVol += v
		anyOK = true
	}

	if anyOK {
		res.SetIfPositive(venue, mVolume24h, totalVol)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f\n", venue, srcGainsNative, totalVol)
	}
	return res, nil
}

func (s *GainsNativeSource) get(url string) ([]byte, error) {
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
