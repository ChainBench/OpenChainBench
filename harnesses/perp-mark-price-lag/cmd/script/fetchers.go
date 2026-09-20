package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Binance spot symbols for each asset.
var binanceSymbols = map[string]string{
	"ETH": "ETHUSDT",
	"BTC": "BTCUSDT",
	"SOL": "SOLUSDT",
}

// Lighter market IDs (verified from orderbook prices 2026-08-02).
var lighterMarketIDs = map[string]string{
	"ETH": "0",
	"BTC": "1",
	"SOL": "2",
}

// Paradex market symbols.
var paradexMarkets = map[string]string{
	"ETH": "ETH-USD-PERP",
	"BTC": "BTC-USD-PERP",
	"SOL": "SOL-USD-PERP",
}

// dYdX market tickers.
var dydxMarkets = map[string]string{
	"ETH": "ETH-USD",
	"BTC": "BTC-USD",
	"SOL": "SOL-USD",
}

func newClient() *http.Client {
	return &http.Client{Timeout: 8 * time.Second}
}

// fetchAllReferences polls Binance bookTicker for all three assets in parallel.
func fetchAllReferences() map[string]float64 {
	assets := []string{"ETH", "BTC", "SOL"}
	refs := make(map[string]float64, len(assets))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, asset := range assets {
		asset := asset
		wg.Add(1)
		go func() {
			defer wg.Done()
			price, err := fetchBinanceRef(asset)
			mu.Lock()
			if err == nil {
				refs[asset] = price
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	return refs
}

// fetchBinanceRef fetches the best-bid/ask mid from Binance bookTicker.
func fetchBinanceRef(asset string) (float64, error) {
	sym, ok := binanceSymbols[asset]
	if !ok {
		return 0, fmt.Errorf("no_binance_symbol_for_%s", asset)
	}
	url := "https://api.binance.com/api/v3/ticker/bookTicker?symbol=" + sym
	client := newClient()
	resp, err := client.Get(url)
	if err != nil {
		return 0, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("status_%d", resp.StatusCode)
	}
	var r struct {
		BidPrice string `json:"bidPrice"`
		AskPrice string `json:"askPrice"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	bid, _ := strconv.ParseFloat(r.BidPrice, 64)
	ask, _ := strconv.ParseFloat(r.AskPrice, 64)
	if bid <= 0 || ask <= 0 {
		return 0, fmt.Errorf("bad_prices")
	}
	return (bid + ask) / 2, nil
}

// Gains and GMX publish their own mark; until 2026-09-20 both were read
// through a Pyth Hermes proxy, and hermes.pyth.network has answered 401 to
// unauthenticated calls since 2026-08-27 (Pyth put Hermes behind API keys),
// which zeroed both venues' success rate for 24 days. The venue feeds are
// the better source anyway: they are the price the venue actually marks at.

// Gains pair indices in the pricing backend's arrays (trading-variables order).
var gainsPairIndex = map[string]int{"BTC": 0, "ETH": 1, "SOL": 33}

// gainsCharts is fetched once per cycle for the three assets (one call,
// 493 pairs); the cache lives for the cycle only.
var gainsChartsCache struct {
	sync.Mutex
	at     time.Time
	closes []float64
	err    string
}

func gainsCloses() ([]float64, string) {
	gainsChartsCache.Lock()
	defer gainsChartsCache.Unlock()
	if time.Since(gainsChartsCache.at) < 5*time.Second && (gainsChartsCache.closes != nil || gainsChartsCache.err != "") {
		return gainsChartsCache.closes, gainsChartsCache.err
	}
	gainsChartsCache.at = time.Now()
	gainsChartsCache.closes, gainsChartsCache.err = nil, ""
	resp, err := newClient().Get("https://backend-pricing.eu.gains.trade/charts")
	if err != nil {
		gainsChartsCache.err = fmt.Sprintf("fetch: %v", err)
		return nil, gainsChartsCache.err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		gainsChartsCache.err = fmt.Sprintf("status_%d", resp.StatusCode)
		return nil, gainsChartsCache.err
	}
	var r struct {
		Time   int64      `json:"time"`
		Closes []*float64 `json:"closes"`
	}
	if err := json.Unmarshal(body, &r); err != nil || len(r.Closes) == 0 {
		gainsChartsCache.err = "parse_error"
		return nil, gainsChartsCache.err
	}
	// The backend stamps the snapshot; a feed older than a minute is stale,
	// not a price the venue marks at right now.
	if r.Time > 0 && time.Since(time.UnixMilli(r.Time)) > time.Minute {
		gainsChartsCache.err = "stale_feed"
		return nil, gainsChartsCache.err
	}
	closes := make([]float64, len(r.Closes))
	for i, c := range r.Closes {
		if c != nil {
			closes[i] = *c
		}
	}
	gainsChartsCache.closes = closes
	return closes, ""
}

// fetchGainsMark reads the venue's own mark from its pricing backend.
func fetchGainsMark(v VenueConfig, ref float64) MarkSample {
	s := MarkSample{Venue: v.Slug, Asset: v.Asset}
	start := time.Now()
	idx, ok := gainsPairIndex[v.Asset]
	if !ok {
		s.Err = "no_pair"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	closes, errStr := gainsCloses()
	if errStr != "" {
		s.Err = errStr
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	if idx >= len(closes) {
		s.Err = "parse_error"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	return finishSample(s, closes[idx], ref, start)
}

// GMX v2 oracle prices are integers scaled to 30 minus the token's decimals.
var gmxPriceScale = map[string]float64{"ETH": 1e12, "BTC": 1e22, "SOL": 1e21}

// fetchGmxMark reads the venue's oracle price (mid of min and max) from the
// GMX v2 API on Arbitrum.
func fetchGmxMark(v VenueConfig, ref float64) MarkSample {
	s := MarkSample{Venue: v.Slug, Asset: v.Asset}
	start := time.Now()
	scale, ok := gmxPriceScale[v.Asset]
	if !ok {
		s.Err = "no_pair"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	resp, err := newClient().Get("https://arbitrum-api.gmxinfra.io/prices/tickers")
	if err != nil {
		s.Err = fmt.Sprintf("fetch: %v", err)
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		s.Err = fmt.Sprintf("status_%d", resp.StatusCode)
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	var tickers []struct {
		TokenSymbol string `json:"tokenSymbol"`
		MinPrice    string `json:"minPrice"`
		MaxPrice    string `json:"maxPrice"`
	}
	if err := json.Unmarshal(body, &tickers); err != nil {
		s.Err = "parse_error"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	for _, t := range tickers {
		if t.TokenSymbol != v.Asset {
			continue
		}
		minP, err1 := strconv.ParseFloat(t.MinPrice, 64)
		maxP, err2 := strconv.ParseFloat(t.MaxPrice, 64)
		if err1 != nil || err2 != nil {
			s.Err = "parse_error"
			s.FetchLatMs = time.Since(start).Milliseconds()
			return s
		}
		return finishSample(s, (minP+maxP)/2/scale, ref, start)
	}
	s.Err = "no_pair"
	s.FetchLatMs = time.Since(start).Milliseconds()
	return s
}

func finishSample(s MarkSample, mark, ref float64, start time.Time) MarkSample {
	if mark <= 0 || ref <= 0 {
		s.Err = "bad_price"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	s.MarkPrice = mark
	s.RefPrice = ref
	s.SignedBps = (mark - ref) / ref * 10000
	s.DeviationBps = math.Abs(s.SignedBps)
	s.FetchLatMs = time.Since(start).Milliseconds()
	return s
}

// fetchHyperliquidMark reads markPx from metaAndAssetCtxs.
func fetchHyperliquidMark(v VenueConfig, ref float64) MarkSample {
	s := MarkSample{Venue: v.Slug, Asset: v.Asset}
	start := time.Now()

	client := newClient()
	body, _ := json.Marshal(map[string]any{"type": "metaAndAssetCtxs"})
	req, _ := http.NewRequest("POST", "https://api.hyperliquid.xyz/info", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		s.Err = fmt.Sprintf("fetch: %v", err)
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	var metaResp []json.RawMessage
	if err := json.Unmarshal(respBody, &metaResp); err != nil || len(metaResp) < 2 {
		s.Err = "parse_meta"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	var meta struct {
		Universe []struct {
			Name string `json:"name"`
		} `json:"universe"`
	}
	var ctxs []struct {
		MarkPx string `json:"markPx"`
	}
	if err := json.Unmarshal(metaResp[0], &meta); err != nil {
		s.Err = "parse_universe"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	if err := json.Unmarshal(metaResp[1], &ctxs); err != nil {
		s.Err = "parse_ctxs"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	var mark float64
	for i, u := range meta.Universe {
		if u.Name == v.Asset && i < len(ctxs) {
			mark, _ = strconv.ParseFloat(ctxs[i].MarkPx, 64)
			break
		}
	}
	if mark <= 0 || ref <= 0 {
		s.Err = "no_mark_price"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	s.MarkPrice = mark
	s.RefPrice = ref
	s.SignedBps = (mark - ref) / ref * 10000
	s.DeviationBps = math.Abs(s.SignedBps)
	s.FetchLatMs = time.Since(start).Milliseconds()
	return s
}

// fetchDYdXMark reads indexPrice from the dYdX v4 indexer.
func fetchDYdXMark(v VenueConfig, ref float64) MarkSample {
	s := MarkSample{Venue: v.Slug, Asset: v.Asset}
	start := time.Now()

	ticker, ok := dydxMarkets[v.Asset]
	if !ok {
		s.Err = "no_dydx_market"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	url := "https://indexer.dydx.trade/v4/perpetualMarkets?ticker=" + ticker
	client := newClient()
	resp, err := client.Get(url)
	if err != nil {
		s.Err = fmt.Sprintf("fetch: %v", err)
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		s.Err = fmt.Sprintf("status_%d", resp.StatusCode)
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	var r struct {
		Markets map[string]struct {
			OraclePrice string `json:"oraclePrice"`
		} `json:"markets"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		s.Err = "parse"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	m, ok := r.Markets[ticker]
	if !ok {
		s.Err = "no_market"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	mark, _ := strconv.ParseFloat(m.OraclePrice, 64)
	if mark <= 0 || ref <= 0 {
		s.Err = "bad_price"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	s.MarkPrice = mark
	s.RefPrice = ref
	s.SignedBps = (mark - ref) / ref * 10000
	s.DeviationBps = math.Abs(s.SignedBps)
	s.FetchLatMs = time.Since(start).Milliseconds()
	return s
}

// fetchLighterMark reads the orderbook mid from Lighter as a mark price proxy.
func fetchLighterMark(v VenueConfig, ref float64) MarkSample {
	s := MarkSample{Venue: v.Slug, Asset: v.Asset}
	start := time.Now()

	marketID, ok := lighterMarketIDs[v.Asset]
	if !ok {
		s.Err = "no_lighter_market"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	url := "https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=" + marketID + "&limit=1"
	client := newClient()
	resp, err := client.Get(url)
	if err != nil {
		s.Err = fmt.Sprintf("fetch: %v", err)
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		s.Err = fmt.Sprintf("status_%d", resp.StatusCode)
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	var r struct {
		Bids []struct {
			Price string `json:"price"`
		} `json:"bids"`
		Asks []struct {
			Price string `json:"price"`
		} `json:"asks"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		s.Err = "parse"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	if len(r.Bids) == 0 || len(r.Asks) == 0 {
		s.Err = "empty_book"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	bid, _ := strconv.ParseFloat(r.Bids[0].Price, 64)
	ask, _ := strconv.ParseFloat(r.Asks[0].Price, 64)
	mark := (bid + ask) / 2
	if mark <= 0 || ref <= 0 {
		s.Err = "bad_price"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	s.MarkPrice = mark
	s.RefPrice = ref
	s.SignedBps = (mark - ref) / ref * 10000
	s.DeviationBps = math.Abs(s.SignedBps)
	s.FetchLatMs = time.Since(start).Milliseconds()
	return s
}

// fetchParadexMark reads markPrice from Paradex /markets.
func fetchParadexMark(v VenueConfig, ref float64) MarkSample {
	s := MarkSample{Venue: v.Slug, Asset: v.Asset}
	start := time.Now()

	market, ok := paradexMarkets[v.Asset]
	if !ok {
		s.Err = "no_paradex_market"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	url := "https://api.prod.paradex.trade/v1/markets/summary?market=" + market
	client := newClient()
	resp, err := client.Get(url)
	if err != nil {
		s.Err = fmt.Sprintf("fetch: %v", err)
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		s.Err = fmt.Sprintf("status_%d", resp.StatusCode)
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	var r struct {
		Results []struct {
			MarkPrice string `json:"mark_price"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &r); err != nil || len(r.Results) == 0 {
		s.Err = "parse"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	mark, _ := strconv.ParseFloat(r.Results[0].MarkPrice, 64)
	if mark <= 0 || ref <= 0 {
		s.Err = "bad_price"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	s.MarkPrice = mark
	s.RefPrice = ref
	s.SignedBps = (mark - ref) / ref * 10000
	s.DeviationBps = math.Abs(s.SignedBps)
	s.FetchLatMs = time.Since(start).Milliseconds()
	return s
}
