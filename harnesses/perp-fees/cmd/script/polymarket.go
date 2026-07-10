package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Polymarket perps (launched 2026-07-08, Polygon settlement, pUSD
// collateral). Public no-auth info API; matching is off-chain so the
// REST book is canonical.

const polymarketBase = "https://api.perpetuals.polymarket.com/v1/info"

type polymarketInstruments []struct {
	InstrumentID int    `json:"instrument_id"`
	Symbol       string `json:"symbol"`
}

type polymarketFees struct {
	FeeSchedule []struct {
		InstrumentType string `json:"instrument_type"`
		TakerFeeRate   string `json:"taker_fee_rate"` // decimal, base tier
	} `json:"fee_schedule"`
}

type polymarketBook struct {
	InstrumentID int         `json:"instrument_id"`
	Bids         [][2]string `json:"bids"` // [price, qty]
	Asks         [][2]string `json:"asks"`
}

type polymarketTickers []struct {
	Symbol      string `json:"symbol"`
	FundingRate string `json:"funding_rate"` // per 1h interval, decimal
}

func fetchPolymarket(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	// 1) Instruments — resolve asset -> instrument_id
	var instruments polymarketInstruments
	if err := polymarketGet(client, polymarketBase+"/instruments", &instruments); err != nil {
		s.Err = fmt.Sprintf("instruments: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	instrumentID := -1
	for _, in := range instruments {
		if in.Symbol == v.Asset+"-USD" {
			instrumentID = in.InstrumentID
			break
		}
	}
	if instrumentID < 0 {
		s.Err = "asset_not_found"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	// 2) Fee schedule — base (tier 0) taker rate. The published tiers go
	// down to 2 bps at $25M 30d volume; the bench quotes the entry tier
	// like every other venue.
	var fees polymarketFees
	if err := polymarketGet(client, polymarketBase+"/fees", &fees); err != nil {
		s.Err = fmt.Sprintf("fees: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	for _, f := range fees.FeeSchedule {
		if f.InstrumentType == "perpetual" {
			rate, _ := strconv.ParseFloat(f.TakerFeeRate, 64)
			s.TakerFeeBps = rate * 10000
			break
		}
	}

	// 3) Orderbook
	var book polymarketBook
	if err := polymarketGet(client, fmt.Sprintf("%s/book?instrument_id=%d&depth=100", polymarketBase, instrumentID), &book); err != nil {
		s.Err = fmt.Sprintf("orderbook: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(book.Bids) == 0 || len(book.Asks) == 0 {
		s.Err = "empty_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	bestBid, _ := strconv.ParseFloat(book.Bids[0][0], 64)
	bestAsk, _ := strconv.ParseFloat(book.Asks[0][0], 64)
	mid := (bestBid + bestAsk) / 2
	s.MidPrice = mid

	levels := make([]bookLevel, 0, len(book.Asks))
	for _, a := range book.Asks {
		px, _ := strconv.ParseFloat(a[0], 64)
		sz, _ := strconv.ParseFloat(a[1], 64)
		levels = append(levels, bookLevel{Px: px, Sz: sz})
	}
	effective, err := walkBookForNotional(levels, v.NotionalUSD)
	if err != nil {
		s.Err = fmt.Sprintf("walk: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.SpreadBps = (effective - mid) / mid * 10000
	s.AllInBps = s.TakerFeeBps + s.SpreadBps
	applyBookTiers(&s, levels, mid)

	// 4) Funding — per 1h native interval, so per-hour bps is direct.
	var tickers polymarketTickers
	if err := polymarketGet(client, polymarketBase+"/tickers", &tickers); err == nil {
		for _, t := range tickers {
			if t.Symbol == v.Asset+"-USD" {
				rate, _ := strconv.ParseFloat(t.FundingRate, 64)
				s.FundingRatePerHrBps = rate * 10000
				break
			}
		}
	}

	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func polymarketGet(client *http.Client, url string, out any) error {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpFees/1.0 contact@mobula.io")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return json.Unmarshal(body, out)
}
