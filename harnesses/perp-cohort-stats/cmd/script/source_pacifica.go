package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// PacificaNativeSource calls the public Pacifica prices endpoint:
//
//	GET https://api.pacifica.fi/api/v1/info/prices
//
// Response shape: `{ "success": true, "data": [{...}, ...] }` with one
// row per market (~70 perps). Each row exposes:
//
//	symbol           (e.g. "BTC")
//	mark             (USD, string)
//	open_interest    (BASE units, string)
//	volume_24h       (USD notional 24h, string; verified live against
//	                  BTC: 431M matches CG perp volume for the venue)
//
// Derived metrics:
//
//	volume_24h_usd            = sum(volume_24h)
//	oi_usd                    = sum(open_interest * mark)
//	active_markets            = count(rows with mark > 0)
//	top_market_volume_24h_usd = max(volume_24h)
type PacificaNativeSource struct {
	client *http.Client
}

func NewPacificaNativeSource() *PacificaNativeSource {
	return &PacificaNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *PacificaNativeSource) Name() string { return srcPacificaNative }

type pacificaRow struct {
	Symbol       string `json:"symbol"`
	Mark         string `json:"mark"`
	OpenInterest string `json:"open_interest"`
	Volume24h    string `json:"volume_24h"`
}

type pacificaResponse struct {
	Success bool          `json:"success"`
	Data    []pacificaRow `json:"data"`
}

func (s *PacificaNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "pacifica"

	body, err := s.get("https://api.pacifica.fi/api/v1/info/prices")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcPacificaNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcPacificaNative, err)
		return res, nil
	}

	var parsed pacificaResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcPacificaNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse: %v\n", venue, srcPacificaNative, err)
		return res, nil
	}

	var volSum, oiSum, topVol float64
	var active int
	for _, r := range parsed.Data {
		mark, _ := strconv.ParseFloat(r.Mark, 64)
		if mark <= 0 {
			continue
		}
		active++
		v, _ := strconv.ParseFloat(r.Volume24h, 64)
		volSum += v
		if v > topVol {
			topVol = v
		}
		oiBase, _ := strconv.ParseFloat(r.OpenInterest, 64)
		oiSum += oiBase * mark
	}

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcPacificaNative, active, volSum, oiSum, topVol)
	return res, nil
}

func (s *PacificaNativeSource) get(url string) ([]byte, error) {
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
