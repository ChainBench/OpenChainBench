package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Extended (Starknet). Public no-auth REST returning the FULL book
// (~$7.6M visible on ETH asks), so every tier walks real depth. The
// taker fee is NOT exposed by any public endpoint: the documented base
// rate (0.025% = 2.5 bps, docs.extended.exchange) is used and disclosed
// in the spec formula, the one exception to the fees-from-API rule.

const extendedBase = "https://api.starknet.extended.exchange/api/v1"

// Documented base taker rate. Revisit if Extended ships a public fees
// endpoint.
const extendedTakerBps = 2.5

type extendedBook struct {
	Status string `json:"status"`
	Data   struct {
		Bid []struct {
			Qty   string `json:"qty"`
			Price string `json:"price"`
		} `json:"bid"`
		Ask []struct {
			Qty   string `json:"qty"`
			Price string `json:"price"`
		} `json:"ask"`
	} `json:"data"`
}

type extendedStats struct {
	Data struct {
		FundingRate string `json:"fundingRate"` // per 1h
	} `json:"data"`
}

func fetchExtended(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}
	market := v.Asset + "-USD"

	s.TakerFeeBps = extendedTakerBps

	var book extendedBook
	if err := extendedGet(client, fmt.Sprintf("%s/info/markets/%s/orderbook", extendedBase, market), &book); err != nil {
		s.Err = fmt.Sprintf("orderbook: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(book.Data.Bid) == 0 || len(book.Data.Ask) == 0 {
		s.Err = "empty_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	bestBid, _ := strconv.ParseFloat(book.Data.Bid[0].Price, 64)
	bestAsk, _ := strconv.ParseFloat(book.Data.Ask[0].Price, 64)
	mid := (bestBid + bestAsk) / 2
	s.MidPrice = mid

	levels := make([]bookLevel, 0, len(book.Data.Ask))
	for _, a := range book.Data.Ask {
		px, _ := strconv.ParseFloat(a.Price, 64)
		sz, _ := strconv.ParseFloat(a.Qty, 64)
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

	var stats extendedStats
	if err := extendedGet(client, fmt.Sprintf("%s/info/markets/%s/stats", extendedBase, market), &stats); err == nil {
		r, _ := strconv.ParseFloat(stats.Data.FundingRate, 64)
		s.FundingRatePerHrBps = r * 10000
	}

	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func extendedGet(client *http.Client, url string, out any) error {
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
