package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"
)

// GMXNativeSource queries the GMX V2 stats API for rolling 24h notional volume.
//
// Endpoint per chain (no auth required, used by stats.gmx.io directly):
//
//	GET https://stats.gmx.io/api/daily-volumes?chain=arbitrum&groupPeriod=3600
//	GET https://stats.gmx.io/api/daily-volumes?chain=avalanche&groupPeriod=3600
//
// groupPeriod=3600 returns hourly buckets. We sort newest-first and sum the
// last 24 to produce the rolling 24h notional in USD. Both chains are summed
// since GMX V2 is deployed on both Arbitrum and Avalanche.
//
// Derived metrics:
//
//	volume_24h_usd = sum(last 24 hourly buckets across arbitrum + avalanche)
type GMXNativeSource struct {
	client *http.Client
}

func NewGMXNativeSource() *GMXNativeSource {
	return &GMXNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *GMXNativeSource) Name() string { return srcGMXNative }

type gmxVolumeBucket struct {
	Timestamp int64   `json:"timestamp"`
	Volume    float64 `json:"volume"`
}

func (s *GMXNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "gmx-v2"

	var totalVol float64
	anyOK := false
	for _, chain := range []string{"arbitrum", "avalanche"} {
		url := fmt.Sprintf("https://stats.gmx.io/api/daily-volumes?chain=%s&groupPeriod=3600", chain)
		body, err := s.get(url)
		if err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcGMXNative, classifyError(err.Error())).Inc()
			fmt.Printf("[perp-cohort][%s][%s] err chain=%s: %v\n", venue, srcGMXNative, chain, err)
			continue
		}
		var buckets []gmxVolumeBucket
		if err := json.Unmarshal(body, &buckets); err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcGMXNative, "parse").Inc()
			fmt.Printf("[perp-cohort][%s][%s] err parse chain=%s: %v\n", venue, srcGMXNative, chain, err)
			continue
		}
		// Sort newest-first, sum the most recent 24 hourly buckets.
		sort.Slice(buckets, func(i, j int) bool {
			return buckets[i].Timestamp > buckets[j].Timestamp
		})
		limit := 24
		if len(buckets) < limit {
			limit = len(buckets)
		}
		var chainVol float64
		for _, b := range buckets[:limit] {
			if b.Volume > 0 {
				chainVol += b.Volume
			}
		}
		fmt.Printf("[perp-cohort][%s][%s] ok: chain=%s buckets=%d vol=%.0f\n",
			venue, srcGMXNative, chain, len(buckets), chainVol)
		totalVol += chainVol
		anyOK = true
	}

	if anyOK {
		res.SetIfPositive(venue, mVolume24h, totalVol)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f\n", venue, srcGMXNative, totalVol)
	}
	return res, nil
}

func (s *GMXNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(b), 200))
	}
	return b, nil
}
