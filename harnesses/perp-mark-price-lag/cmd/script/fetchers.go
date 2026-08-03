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

// Pyth price feed IDs for ETH/USD, BTC/USD, SOL/USD.
var pythFeedIDs = map[string]string{
	"ETH": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
	"BTC": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
	"SOL": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
}

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

// fetchOracleVenue fetches the Pyth price as a proxy for gains/gmx oracle mark.
func fetchOracleVenue(v VenueConfig, ref float64, slug string) MarkSample {
	s := MarkSample{Venue: v.Slug, Asset: v.Asset}
	start := time.Now()

	feedID, ok := pythFeedIDs[v.Asset]
	if !ok {
		s.Err = "no_pyth_feed"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	url := "https://hermes.pyth.network/v2/updates/price/latest?ids[]=" + feedID
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
		Parsed []struct {
			Price struct {
				Price string `json:"price"`
				Expo  int    `json:"expo"`
			} `json:"price"`
		} `json:"parsed"`
	}
	if err := json.Unmarshal(body, &r); err != nil || len(r.Parsed) == 0 {
		s.Err = "parse_error"
		s.FetchLatMs = time.Since(start).Milliseconds()
		return s
	}

	rawPrice, _ := strconv.ParseFloat(r.Parsed[0].Price.Price, 64)
	expo := r.Parsed[0].Price.Expo
	mark := rawPrice * math.Pow10(expo)

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
		Universe []struct{ Name string `json:"name"` } `json:"universe"`
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
		Bids []struct{ Price string `json:"price"` } `json:"bids"`
		Asks []struct{ Price string `json:"price"` } `json:"asks"`
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
