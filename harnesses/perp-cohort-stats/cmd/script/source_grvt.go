package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// GrvtNativeSource hits the GRVT market-data POST API (public, no
// auth):
//
//	POST https://market-data.grvt.io/full/v1/all_instruments  {}
//	POST https://market-data.grvt.io/full/v1/ticker           {"instrument": "<sym>"}
//
// /all_instruments returns one row per tradable contract. We filter
// kind == "PERPETUAL". /ticker has no bulk shape, so the per-symbol
// loop runs in a background goroutine throttled to 10 req/s and the
// resulting USD volumes + open interest map is cached for 5 minutes.
// At ~170 perp markets the background loop takes ~17s.
//
// Derived metrics:
//
//	volume_24h_usd            = sum(buy_volume_24h_q + sell_volume_24h_q)
//	oi_usd                    = sum(open_interest * mark_price)
//	active_markets            = count(perpetual instruments)
//	top_market_volume_24h_usd = max(per-market 24h USD volume)
type GrvtNativeSource struct {
	client       *http.Client
	mu           sync.Mutex
	cache        map[string]grvtTickerRow
	cacheTS      time.Time
	refreshing   bool
}

type grvtTickerRow struct {
	volumeQ float64
	oi      float64
	mark    float64
}

func NewGrvtNativeSource() *GrvtNativeSource {
	return &GrvtNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
		cache:  map[string]grvtTickerRow{},
	}
}

func (s *GrvtNativeSource) Name() string { return srcGrvtNative }

type grvtInstrument struct {
	Instrument string `json:"instrument"`
	Kind       string `json:"kind"`
}

type grvtInstrumentsResponse struct {
	Result []grvtInstrument `json:"result"`
}

type grvtTickerResponse struct {
	Result struct {
		Instrument      string `json:"instrument"`
		MarkPrice       string `json:"mark_price"`
		BuyVolume24hQ   string `json:"buy_volume_24h_q"`
		SellVolume24hQ  string `json:"sell_volume_24h_q"`
		OpenInterest    string `json:"open_interest"`
	} `json:"result"`
}

const grvtCacheTTL = 5 * time.Minute

func (s *GrvtNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "grvt"

	// Step 1: instrument catalog (small, fast, one request).
	body, err := s.post("https://market-data.grvt.io/full/v1/all_instruments", []byte(`{}`))
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcGrvtNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err catalog: %v\n", venue, srcGrvtNative, err)
		return res, nil
	}
	var catalog grvtInstrumentsResponse
	if err := json.Unmarshal(body, &catalog); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcGrvtNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse catalog: %v\n", venue, srcGrvtNative, err)
		return res, nil
	}
	var perps []string
	for _, i := range catalog.Result {
		if i.Kind != "PERPETUAL" {
			continue
		}
		perps = append(perps, i.Instrument)
	}

	// Step 2: kick off async per-symbol ticker refresh if stale.
	s.maybeRefresh(perps)

	// Step 3: aggregate from whatever cache snapshot exists.
	s.mu.Lock()
	var volSum, oiSum, topVol float64
	var active int
	for _, row := range s.cache {
		if row.mark <= 0 {
			continue
		}
		active++
		volSum += row.volumeQ
		if row.volumeQ > topVol {
			topVol = row.volumeQ
		}
		oiSum += row.oi * row.mark
	}
	cached := len(s.cache)
	s.mu.Unlock()

	// active_markets is always emitted from the catalog (the cache may
	// be empty on the first sweep). The other gauges are conditioned
	// on SetIfPositive so they only land after the cache fills.
	res.SetIfPositive(venue, mActiveMarkets, float64(len(perps)))
	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: perps=%d cached=%d active=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcGrvtNative, len(perps), cached, active, volSum, oiSum, topVol)
	return res, nil
}

func (s *GrvtNativeSource) maybeRefresh(symbols []string) {
	s.mu.Lock()
	if s.refreshing {
		s.mu.Unlock()
		return
	}
	if time.Since(s.cacheTS) < grvtCacheTTL && len(s.cache) > 0 {
		s.mu.Unlock()
		return
	}
	s.refreshing = true
	s.mu.Unlock()

	go s.runRefresh(symbols)
}

func (s *GrvtNativeSource) runRefresh(symbols []string) {
	defer func() {
		s.mu.Lock()
		s.refreshing = false
		s.mu.Unlock()
	}()

	fresh := map[string]grvtTickerRow{}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for _, sym := range symbols {
		<-tick.C
		req := fmt.Sprintf(`{"instrument":%q}`, sym)
		body, err := s.post("https://market-data.grvt.io/full/v1/ticker", []byte(req))
		if err != nil {
			continue
		}
		var tk grvtTickerResponse
		if err := json.Unmarshal(body, &tk); err != nil {
			continue
		}
		mark, _ := strconv.ParseFloat(tk.Result.MarkPrice, 64)
		buy, _ := strconv.ParseFloat(tk.Result.BuyVolume24hQ, 64)
		sell, _ := strconv.ParseFloat(tk.Result.SellVolume24hQ, 64)
		oi, _ := strconv.ParseFloat(tk.Result.OpenInterest, 64)
		fresh[sym] = grvtTickerRow{volumeQ: buy + sell, oi: oi, mark: mark}
	}

	s.mu.Lock()
	s.cache = fresh
	s.cacheTS = time.Now()
	s.mu.Unlock()
	fmt.Printf("[perp-cohort][grvt][%s] cache refreshed: %d perps\n", srcGrvtNative, len(fresh))
}

func (s *GrvtNativeSource) post(url string, body []byte) ([]byte, error) {
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
