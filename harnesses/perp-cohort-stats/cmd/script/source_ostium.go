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
// for 24h rolling volume, OI, and active market count. The subgraph URL
// is the one shipped inside the official ostium-python-sdk
// (config.py::NetworkConfig.mainnet); no API key is required:
//
//	POST https://api.subgraph.ormilabs.com/api/public/<token>/subgraphs/ost-prod/live/gn
//
// Volume 24h:
//
//	Query: trades(where:{timestamp_gte: now-86400}, first:1000)
//	Field: notional (BigInt string, USDC 6-decimal scale = 1e6 per USD)
//	Sum all trade notionals, divide by 1e6 to get USD.
//	Trades are paginated in blocks of 1000 by skip offset.
//
// OI:
//
//	Each Pair row exposes longOI, shortOI (base-token units, 1e18 scale)
//	and lastTradePrice (USD, 1e18 scale).
//	OI in USD = sum((longOI + shortOI) / 1e18 * lastTradePrice / 1e18)
//
// Derived metrics:
//
//	volume_24h_usd  = sum(trade.notional over last 24h) / 1e6
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

type ostiumTradesResp struct {
	Data struct {
		Trades []struct {
			Notional string `json:"notional"`
		} `json:"trades"`
	} `json:"data"`
}

// fetchVol24h sums trade notionals for all trades opened in the last 24h.
// notional is in USDC internal units where 1e6 = $1 USD.
func (s *OstiumNativeSource) fetchVol24h(since int64) (float64, error) {
	const pageSize = 1000
	var total int64
	skip := 0
	for {
		q := fmt.Sprintf(`{ trades(first:%d, skip:%d, where:{timestamp_gte:%d}) { notional } }`,
			pageSize, skip, since)
		body, err := s.post(ostiumSubgraphURL, map[string]string{"query": q})
		if err != nil {
			return 0, err
		}
		var parsed ostiumTradesResp
		if err := json.Unmarshal(body, &parsed); err != nil {
			return 0, fmt.Errorf("parse: %w", err)
		}
		for _, t := range parsed.Data.Trades {
			n, _ := strconv.ParseInt(t.Notional, 10, 64)
			total += n
		}
		if len(parsed.Data.Trades) < pageSize {
			break
		}
		skip += pageSize
	}
	return float64(total) / 1e6, nil
}

func (s *OstiumNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "ostium"
	since := time.Now().Unix() - 86400

	// Volume 24h
	vol, volErr := s.fetchVol24h(since)
	if volErr != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcOstiumNative, classifyError(volErr.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] vol err: %v\n", venue, srcOstiumNative, volErr)
	} else {
		res.SetIfPositive(venue, mVolume24h, vol)
	}

	// OI + active markets
	body, err := s.post(ostiumSubgraphURL, map[string]string{"query": ostiumPairsQuery})
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcOstiumNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] pairs err: %v\n", venue, srcOstiumNative, err)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f\n", venue, srcOstiumNative, vol)
		return res, nil
	}

	var parsed ostiumResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcOstiumNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] pairs parse err: %v\n", venue, srcOstiumNative, err)
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
	fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f active=%d oi=%.0f\n",
		venue, srcOstiumNative, vol, active, oiSum)
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
