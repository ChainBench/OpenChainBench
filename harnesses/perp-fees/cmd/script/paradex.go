package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Paradex (Starknet appchain). Public no-auth REST. The book endpoint
// caps at depth=100 (~$1M visible on majors), so the $1M tier can be
// legitimately skipped when the visible book thins out.

const paradexBase = "https://api.prod.paradex.trade/v1"

type paradexMarkets struct {
	Results []struct {
		Symbol    string `json:"symbol"`
		FeeConfig struct {
			APIFee struct {
				TakerFee struct {
					Fee string `json:"fee"` // decimal, e.g. "0.0002"
				} `json:"taker_fee"`
			} `json:"api_fee"`
		} `json:"fee_config"`
	} `json:"results"`
}

type paradexBook struct {
	Asks [][2]string `json:"asks"` // [price, size] strings
	Bids [][2]string `json:"bids"`
}

type paradexFunding struct {
	Results []struct {
		FundingRate string `json:"funding_rate"` // per 8h period
	} `json:"results"`
}

func fetchParadex(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}
	market := v.Asset + "-USD-PERP"

	// 1) Taker fee from the market's fee config (api tier, not the UI one).
	var mkts paradexMarkets
	if err := paradexGet(client, fmt.Sprintf("%s/markets?market=%s", paradexBase, market), &mkts); err != nil {
		s.Err = fmt.Sprintf("markets: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(mkts.Results) == 0 {
		s.Err = "asset_not_found"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	rate, _ := strconv.ParseFloat(mkts.Results[0].FeeConfig.APIFee.TakerFee.Fee, 64)
	s.TakerFeeBps = rate * 10000

	// 2) Orderbook (max depth 100).
	var book paradexBook
	if err := paradexGet(client, fmt.Sprintf("%s/orderbook/%s?depth=100", paradexBase, market), &book); err != nil {
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

	// 3) Funding: per 8h period, normalize to per hour.
	var fund paradexFunding
	if err := paradexGet(client, fmt.Sprintf("%s/funding/data?market=%s&page_size=1", paradexBase, market), &fund); err == nil && len(fund.Results) > 0 {
		r, _ := strconv.ParseFloat(fund.Results[0].FundingRate, 64)
		s.FundingRatePerHrBps = r / 8 * 10000
	}

	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func paradexGet(client *http.Client, url string, out any) error {
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
