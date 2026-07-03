package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AsterNativeSource hits the asterdex.com futures gateway:
//
//	GET https://fapi.asterdex.com/fapi/v1/ticker/24hr         (bulk volume)
//	GET https://fapi.asterdex.com/fapi/v1/openInterest?symbol=X  (per symbol)
//
// Volume + count come from a single ticker call that returns one row
// per symbol (~495 rows). OI is per-symbol only; we throttle the loop
// to 10 req/s and cache the resulting OI map for 30s so the inner
// 60s tick reuses it once. With ~495 symbols a fresh OI sweep takes
// ~50s, just inside the 60s tick budget.
//
// Symbols ending in `USDT` are linear perp pairs; the small set of
// USDC-quoted pairs is included via the same suffix filter
// (`USDT`||`USDC`).
//
// Derived metrics:
//
//	volume_24h_usd            = sum(quoteVolume)
//	oi_usd                    = sum(openInterest_base * lastPrice)
//	active_markets            = count(symbols with priceChangePercent != 0)
//	top_market_volume_24h_usd = max(quoteVolume)
type AsterNativeSource struct {
	client       *http.Client
	oiMu         sync.Mutex
	oiCache      map[string]float64
	oiTS         time.Time
	oiRefreshing bool
}

func NewAsterNativeSource() *AsterNativeSource {
	return &AsterNativeSource{
		client:  &http.Client{Timeout: 15 * time.Second},
		oiCache: map[string]float64{},
	}
}

func (s *AsterNativeSource) Name() string { return srcAsterNative }

type asterTicker struct {
	Symbol               string `json:"symbol"`
	LastPrice            string `json:"lastPrice"`
	PriceChangePercent   string `json:"priceChangePercent"`
	Volume               string `json:"volume"`
	QuoteVolume          string `json:"quoteVolume"`
}

type asterOIResponse struct {
	Symbol       string `json:"symbol"`
	OpenInterest string `json:"openInterest"`
	Time         int64  `json:"time"`
}

// asterOICacheTTL keeps the per-symbol OI map fresh enough for an
// OI gauge that updates ~12x/hour while keeping per-tick request load
// under control. A full OI sweep at 10 req/s over ~495 symbols takes
// ~50s; refreshing every 5 min means we burn ~1 minute of HTTP every
// 5 minutes (sustained ~1.6 req/s averaged) which is well under any
// reasonable public rate limit.
const asterOICacheTTL = 5 * time.Minute

func (s *AsterNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "aster"

	// Step 1: bulk ticker for the whole symbol universe.
	body, err := s.get("https://fapi.asterdex.com/fapi/v1/ticker/24hr")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcAsterNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err ticker: %v\n", venue, srcAsterNative, err)
		return res, nil
	}
	var tickers []asterTicker
	if err := json.Unmarshal(body, &tickers); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcAsterNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse ticker: %v\n", venue, srcAsterNative, err)
		return res, nil
	}

	keep := make([]asterRow, 0, len(tickers))
	var volSum, topVol float64
	for _, t := range tickers {
		// Linear perp pairs only.
		if !strings.HasSuffix(t.Symbol, "USDT") && !strings.HasSuffix(t.Symbol, "USDC") {
			continue
		}
		qv, _ := strconv.ParseFloat(t.QuoteVolume, 64)
		last, _ := strconv.ParseFloat(t.LastPrice, 64)
		volSum += qv
		if qv > topVol {
			topVol = qv
		}
		keep = append(keep, asterRow{symbol: t.Symbol, last: last, qvol: qv})
	}

	// Step 2: kick off async OI refresh if the cache is stale. The
	// refresh runs in the background so a single sweep never blocks
	// for the full ~50s OI loop; first-tick OI is 0 (Set is skipped),
	// subsequent ticks see the cached map.
	s.maybeRefreshOI(keep)

	// Step 3: aggregate OI in USD from the cached map.
	s.oiMu.Lock()
	var oiSum float64
	for _, r := range keep {
		if r.last <= 0 {
			continue
		}
		if oiBase, ok := s.oiCache[r.symbol]; ok {
			oiSum += oiBase * r.last
		}
	}
	cached := len(s.oiCache)
	s.oiMu.Unlock()

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(len(keep)))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: markets=%d oi_cached=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcAsterNative, len(keep), cached, volSum, oiSum, topVol)
	return res, nil
}

type asterRow struct {
	symbol string
	last   float64
	qvol   float64
}

// maybeRefreshOI schedules a background OI refresh if the cache is
// stale and no refresh is already running. The actual loop runs in a
// goroutine at 10 req/s; the calling Fetch() returns immediately with
// whatever map snapshot is currently cached.
func (s *AsterNativeSource) maybeRefreshOI(symbols []asterRow) {
	s.oiMu.Lock()
	if s.oiRefreshing {
		s.oiMu.Unlock()
		return
	}
	if time.Since(s.oiTS) < asterOICacheTTL && len(s.oiCache) > 0 {
		s.oiMu.Unlock()
		return
	}
	s.oiRefreshing = true
	s.oiMu.Unlock()

	go s.runOIRefresh(symbols)
}

func (s *AsterNativeSource) runOIRefresh(symbols []asterRow) {
	defer func() {
		s.oiMu.Lock()
		s.oiRefreshing = false
		s.oiMu.Unlock()
	}()

	fresh := map[string]float64{}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for _, r := range symbols {
		<-tick.C
		body, err := s.get(fmt.Sprintf(
			"https://fapi.asterdex.com/fapi/v1/openInterest?symbol=%s", r.symbol))
		if err != nil {
			continue
		}
		var oi asterOIResponse
		if err := json.Unmarshal(body, &oi); err != nil {
			continue
		}
		base, _ := strconv.ParseFloat(oi.OpenInterest, 64)
		if base > 0 {
			fresh[r.symbol] = base
		}
	}

	s.oiMu.Lock()
	s.oiCache = fresh
	s.oiTS = time.Now()
	s.oiMu.Unlock()
	fmt.Printf("[perp-cohort][aster][%s] oi cache refreshed: %d symbols\n", srcAsterNative, len(fresh))
}

func (s *AsterNativeSource) get(url string) ([]byte, error) {
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
