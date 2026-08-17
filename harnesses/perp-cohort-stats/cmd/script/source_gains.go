package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// GainsNativeSource queries the Gains Network stats backend for rolling 24h
// trading volume across all active chains.
//
// Endpoint:
//
//	GET https://stats.gains.trade/volume
//
// The response includes a `totalVolume` field (rolling 24h USD notional) and
// a `sources` array with per-chain breakdowns (arbitrum, base, polygon, etc.).
// We use the `totalVolume` field as the canonical single-number for the venue.
//
// Derived metrics:
//
//	volume_24h_usd = totalVolume (USD, 24h rolling, all chains combined)
type GainsNativeSource struct {
	client *http.Client
}

func NewGainsNativeSource() *GainsNativeSource {
	return &GainsNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *GainsNativeSource) Name() string { return srcGainsNative }

type gainsVolumeResp struct {
	TotalVolume  float64 `json:"totalVolume"`
	LastRefreshed string `json:"lastRefreshed"`
	Sources      []struct {
		Chain  string  `json:"chain"`
		Volume float64 `json:"volume"`
	} `json:"sources"`
}

func (s *GainsNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "gains"

	body, err := s.get("https://stats.gains.trade/volume")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcGainsNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcGainsNative, err)
		return res, nil
	}

	var resp gainsVolumeResp
	if err := json.Unmarshal(body, &resp); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcGainsNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse: %v\n", venue, srcGainsNative, err)
		return res, nil
	}

	if resp.TotalVolume > 0 {
		res.SetIfPositive(venue, mVolume24h, resp.TotalVolume)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f (refreshed=%s)\n",
			venue, srcGainsNative, resp.TotalVolume, resp.LastRefreshed)
		for _, src := range resp.Sources {
			if src.Volume > 0 {
				fmt.Printf("[perp-cohort][%s][%s]   chain=%s vol=%.0f\n",
					venue, srcGainsNative, src.Chain, src.Volume)
			}
		}
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
