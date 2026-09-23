package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// ApexNativeSource reads ApeX Omni (orderbook perps, omnichain deposits)
// from its public v3 API:
//
//	GET https://omni.apex.exchange/api/v3/symbols                 (catalog)
//	GET https://omni.apex.exchange/api/v3/ticker?symbol=<CROSS>   (24 h stats, one call per market)
//
// The catalog splits contracts by kind: perpetualContract (crypto),
// stockContract (US equities and ETFs as perps) and predictionContract
// (binary event markets, not perps, excluded). Rows with enableTrade
// and enableDisplay are live. The ticker endpoint has no bulk form and
// returns nothing without a symbol, so the harness walks the live
// contracts at 5 req/s and caches the result for apexCacheTTL, the way
// the edgeX source does. Funding is hourly (history-funding rows are
// one hour apart).
//
// Derived metrics:
//
//	volume_24h_usd            = sum(turnover24h) over live contracts
//	oi_usd                    = sum(openInterest * markPrice)
//	active_markets            = count(live perpetual + stock contracts)
//	top_market_volume_24h_usd = max(turnover24h)
//	funding (BTC, ETH, SOL)   = fundingRate x 24 x 10000 bps per day, 1 h interval
type ApexNativeSource struct {
	client     *http.Client
	mu         sync.Mutex
	cache      map[string]apexTickerRow
	cacheTS    time.Time
	refreshing bool
}

type apexTickerRow struct {
	turnover float64
	oi       float64
	mark     float64
	funding  float64
}

type apexContract struct {
	Symbol          string `json:"symbol"`          // BTC-USDT
	CrossSymbolName string `json:"crossSymbolName"` // BTCUSDT, the ticker key
	EnableTrade     bool   `json:"enableTrade"`
	EnableDisplay   bool   `json:"enableDisplay"`
}

type apexSymbolsResponse struct {
	Data struct {
		ContractConfig struct {
			PerpetualContract []apexContract `json:"perpetualContract"`
			StockContract     []apexContract `json:"stockContract"`
		} `json:"contractConfig"`
	} `json:"data"`
}

type apexTickerResponse struct {
	Data []struct {
		Symbol       string `json:"symbol"`
		Turnover24h  string `json:"turnover24h"`
		OpenInterest string `json:"openInterest"`
		MarkPrice    string `json:"markPrice"`
		FundingRate  string `json:"fundingRate"`
	} `json:"data"`
}

const apexCacheTTL = 5 * time.Minute

func NewApexNativeSource() *ApexNativeSource {
	return &ApexNativeSource{client: &http.Client{Timeout: 15 * time.Second}, cache: map[string]apexTickerRow{}}
}

func (s *ApexNativeSource) Name() string { return srcApexNative }

// apexLive is a live contract with the breadth class its catalog list
// implies: perpetualContract rows are tokens, stockContract rows are
// equities or ETFs split by the symbol tables (USO is an oil ETF and
// stays a stock, IWM tracks an index).
type apexLive struct {
	cross string
	base  string
	class string
}

func (s *ApexNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "apex"

	body, err := s.get("https://omni.apex.exchange/api/v3/symbols")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcApexNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err symbols: %v\n", venue, srcApexNative, err)
		return res, nil
	}
	var cat apexSymbolsResponse
	if err := json.Unmarshal(body, &cat); err != nil || len(cat.Data.ContractConfig.PerpetualContract) == 0 {
		perpCohortFetchErrors.WithLabelValues(venue, srcApexNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse symbols: %v\n", venue, srcApexNative, err)
		return res, nil
	}
	var live []apexLive
	breadth := breadthCounter{}
	for _, c := range cat.Data.ContractConfig.PerpetualContract {
		if c.EnableTrade && c.EnableDisplay {
			base := baseSymbol(c.Symbol)
			live = append(live, apexLive{cross: c.CrossSymbolName, base: base, class: classCrypto})
			breadth.add(classCrypto)
			res.AddCryptoSymbol(base)
		}
	}
	for _, c := range cat.Data.ContractConfig.StockContract {
		if c.EnableTrade && c.EnableDisplay {
			base := baseSymbol(c.Symbol)
			class := rwaClass(base)
			live = append(live, apexLive{cross: c.CrossSymbolName, base: base, class: class})
			breadth.add(class)
			res.AddRWASymbol(base)
		}
	}
	if len(live) == 0 {
		perpCohortFetchErrors.WithLabelValues(venue, srcApexNative, "parse").Inc()
		return res, nil
	}
	res.SetIfPositive(venue, mActiveMarkets, float64(len(live)))
	res.SetBreadth(venue, breadth)

	s.maybeRefresh(live)

	s.mu.Lock()
	var volSum, oiSum, topVol float64
	// Funding is a rate, not a total: a snapshot kept through a degraded
	// refresh (under 90 % of contracts answered) must not republish a
	// frozen rate as fresh. Two TTLs is one missed refresh; beyond that
	// the funding surface goes quiet and the router's five-minute reap
	// drops the venue's rate (same gate as edgeX, review 2026-09-23).
	fundingFresh := time.Since(s.cacheTS) < 2*apexCacheTTL
	for _, l := range live {
		row, ok := s.cache[l.cross]
		if !ok {
			continue
		}
		volSum += row.turnover
		if row.turnover > topVol {
			topVol = row.turnover
		}
		oiSum += row.oi * row.mark
		switch l.base {
		case "BTC", "ETH", "SOL":
			if fundingFresh {
				res.SetFunding(venue, l.base, fundingPoint{Bps24h: row.funding * 24 * 10000, IntervalHours: 1})
			}
		}
	}
	cached := len(s.cache)
	s.mu.Unlock()

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: live=%d cached=%d vol24h=%.0f oi=%.0f top24h=%.0f breadth: %s\n",
		venue, srcApexNative, len(live), cached, volSum, oiSum, topVol, breadth)
	return res, nil
}

func (s *ApexNativeSource) maybeRefresh(live []apexLive) {
	s.mu.Lock()
	if s.refreshing || (time.Since(s.cacheTS) < apexCacheTTL && len(s.cache) > 0) {
		s.mu.Unlock()
		return
	}
	s.refreshing = true
	s.mu.Unlock()
	go s.runRefresh(live)
}

func (s *ApexNativeSource) runRefresh(live []apexLive) {
	defer func() {
		s.mu.Lock()
		s.refreshing = false
		s.mu.Unlock()
	}()
	fresh := map[string]apexTickerRow{}
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	var fails int
	for _, l := range live {
		<-tick.C
		body, err := s.get("https://omni.apex.exchange/api/v3/ticker?symbol=" + l.cross)
		if err != nil {
			fails++
			perpCohortFetchErrors.WithLabelValues("apex", srcApexNative, classifyError(err.Error())).Inc()
			continue
		}
		var t apexTickerResponse
		if err := json.Unmarshal(body, &t); err != nil || len(t.Data) == 0 {
			fails++
			perpCohortFetchErrors.WithLabelValues("apex", srcApexNative, "parse").Inc()
			continue
		}
		row := t.Data[0]
		turnover, _ := strconv.ParseFloat(row.Turnover24h, 64)
		oi, _ := strconv.ParseFloat(row.OpenInterest, 64)
		mark, _ := strconv.ParseFloat(row.MarkPrice, 64)
		funding, _ := strconv.ParseFloat(row.FundingRate, 64)
		fresh[l.cross] = apexTickerRow{turnover: turnover, oi: oi, mark: mark, funding: funding}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// A partial walk swapped in would publish a venue total missing the
	// markets that failed; below 90 % the previous snapshot stays and the
	// shortfall is counted on the errors counter above.
	if len(fresh)*10 < len(live)*9 {
		fmt.Printf("[perp-cohort][apex][%s] cache refresh DEGRADED: %d/%d ok, %d fails; keeping prior snapshot (%d)\n",
			srcApexNative, len(fresh), len(live), fails, len(s.cache))
		perpCohortFetchErrors.WithLabelValues("apex", srcApexNative, "degraded_refresh").Inc()
		return
	}
	s.cache = fresh
	s.cacheTS = time.Now()
	fmt.Printf("[perp-cohort][apex][%s] cache refreshed: %d contracts (%d fails)\n", srcApexNative, len(fresh), fails)
}

func (s *ApexNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; OpenChainBench-PerpCohort/1.0; contact@openchainbench.com)")
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
