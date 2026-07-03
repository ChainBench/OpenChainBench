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

// OstiumNativeSource queries the Ormi-hosted Ostium mainnet subgraph
// for per-pair OI and active count. The subgraph URL is the one
// shipped inside the official ostium-python-sdk
// (config.py::NetworkConfig.mainnet); no API key is required:
//
//	POST https://api.subgraph.ormilabs.com/api/public/<token>/subgraphs/ost-prod/live/gn
//
// Each Pair row exposes:
//
//	id, from, to            (e.g. "0", "BTC", "USD")
//	longOI, shortOI         (BASE units scaled by 1e18, string)
//	lastTradePrice          (USD scaled by 1e18, string)
//
// Volume 24h is NOT exposed as a rolling-window aggregate on the
// subgraph (only lifetime `volume` + buy/sell totals are available, in
// 1e8 USD scale), so this source publishes OI + active_markets only.
// The router keeps DefiLlama as the fallback for vol_24h / vol_30d
// (Ostium total24h on DefiLlama is live and matches the dashboard).
//
// Derived metrics:
//
//	oi_usd          = sum((longOI + shortOI) / 1e18 * lastTradePrice / 1e18)
//	active_markets  = count(pairs with lastTradePrice > 0)
type OstiumNativeSource struct {
	client *http.Client
}

func NewOstiumNativeSource() *OstiumNativeSource {
	return &OstiumNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *OstiumNativeSource) Name() string { return srcOstiumNative }

const ostiumSubgraphURL = "https://api.subgraph.ormilabs.com/api/public/67a599d5-c8d2-4cc4-9c4d-2975a97bc5d8/subgraphs/ost-prod/live/gn"

const ostiumPairsQuery = `{
  pairs(first: 200) {
    id
    longOI
    shortOI
    lastTradePrice
  }
}`

type ostiumPair struct {
	ID             string `json:"id"`
	LongOI         string `json:"longOI"`
	ShortOI        string `json:"shortOI"`
	LastTradePrice string `json:"lastTradePrice"`
}

type ostiumResponse struct {
	Data struct {
		Pairs []ostiumPair `json:"pairs"`
	} `json:"data"`
}

func (s *OstiumNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "ostium"

	body, err := s.post(ostiumSubgraphURL, map[string]string{"query": ostiumPairsQuery})
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcOstiumNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcOstiumNative, err)
		return res, nil
	}

	var parsed ostiumResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcOstiumNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse: %v\n", venue, srcOstiumNative, err)
		return res, nil
	}

	const scale1e18 = 1e18
	var oiSum float64
	var active int
	for _, p := range parsed.Data.Pairs {
		longRaw, _ := strconv.ParseFloat(p.LongOI, 64)
		shortRaw, _ := strconv.ParseFloat(p.ShortOI, 64)
		pxRaw, _ := strconv.ParseFloat(p.LastTradePrice, 64)
		if pxRaw <= 0 {
			continue
		}
		active++
		long := longRaw / scale1e18
		short := shortRaw / scale1e18
		px := pxRaw / scale1e18
		oiSum += (long + short) * px
	}

	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d oi=%.0f\n",
		venue, srcOstiumNative, active, oiSum)
	return res, nil
}

func (s *OstiumNativeSource) post(url string, payload any) ([]byte, error) {
	buf, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(buf))
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
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
