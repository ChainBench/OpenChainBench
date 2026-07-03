package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// HyperliquidNativeSource calls the public info endpoint:
//
//	POST https://api.hyperliquid.xyz/info  body: {"type":"metaAndAssetCtxs"}
//
// The response is a tuple `[meta, ctxs]`:
//   - meta.universe is an array of assets (BTC, ETH, ATOM, ...) with
//     szDecimals and a possible `isDelisted` flag.
//   - ctxs is a parallel array of contexts, each with stringified
//     numeric fields: markPx, openInterest, dayNtlVlm (notional 24h
//     volume in USD), funding, prevDayPx.
//
// Derived metrics:
//
//	volume_24h_usd            = sum(dayNtlVlm)
//	oi_usd                    = sum(openInterest * markPx)
//	active_markets            = count(non-delisted universe entries)
//	top_market_volume_24h_usd = max(dayNtlVlm)
type HyperliquidNativeSource struct {
	client *http.Client
}

func NewHyperliquidNativeSource() *HyperliquidNativeSource {
	return &HyperliquidNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *HyperliquidNativeSource) Name() string { return srcHLNative }

type hlMeta struct {
	Universe []hlUniverseEntry `json:"universe"`
}

type hlUniverseEntry struct {
	Name       string `json:"name"`
	IsDelisted bool   `json:"isDelisted"`
}

// hlCtx fields arrive as JSON strings; we parse manually rather than
// drop a flexFloat custom unmarshaler here because the struct is tight.
type hlCtx struct {
	DayNtlVlm    string `json:"dayNtlVlm"`
	OpenInterest string `json:"openInterest"`
	MarkPx       string `json:"markPx"`
	Funding      string `json:"funding"`
}

func (s *HyperliquidNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "hyperliquid"

	url := "https://api.hyperliquid.xyz/info"
	body, err := s.post(url, []byte(`{"type":"metaAndAssetCtxs"}`))
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcHLNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcHLNative, err)
		return res, nil
	}

	// Response shape: [meta, ctxs]. meta is decoded once for universe
	// length / delisted flags, ctxs is decoded as an array of objects.
	var raw []json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil || len(raw) != 2 {
		perpCohortFetchErrors.WithLabelValues(venue, srcHLNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: parse top-level: %v\n", venue, srcHLNative, err)
		return res, nil
	}
	var meta hlMeta
	if err := json.Unmarshal(raw[0], &meta); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcHLNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: parse meta: %v\n", venue, srcHLNative, err)
		return res, nil
	}
	var ctxs []hlCtx
	if err := json.Unmarshal(raw[1], &ctxs); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcHLNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: parse ctxs: %v\n", venue, srcHLNative, err)
		return res, nil
	}

	var volSum, oiSum, topVol float64
	var activeCount int
	for i, c := range ctxs {
		if i >= len(meta.Universe) {
			break
		}
		if meta.Universe[i].IsDelisted {
			continue
		}
		activeCount++
		v := parseFloat(c.DayNtlVlm)
		volSum += v
		if v > topVol {
			topVol = v
		}
		oi := parseFloat(c.OpenInterest)
		mark := parseFloat(c.MarkPx)
		oiSum += oi * mark
	}

	// Skip metrics that came back as zero. A truly zero value means the
	// venue is dead, the upstream had an outage, or the response shape
	// drifted: in every case carry-forward beats overwriting with 0.
	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(activeCount))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcHLNative, activeCount, volSum, oiSum, topVol)
	return res, nil
}

func (s *HyperliquidNativeSource) post(url string, body []byte) ([]byte, error) {
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
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

func parseFloat(s string) float64 {
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}
