package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Lighter zk-rollup. Public no-auth API. Markets and orderbook directly
// expose fees and depth.

const lighterBase = "https://mainnet.zklighter.elliot.ai/api/v1"

type lighterMarketDetails struct {
	OrderBookDetails []struct {
		Symbol     string `json:"symbol"`
		MarketID   int    `json:"market_id"`
		MarketType string `json:"market_type"`
		Status     string `json:"status"`
		TakerFee   string `json:"taker_fee"` // pct, e.g. "0.0250" = 0.025% = 2.5 bps
		MakerFee   string `json:"maker_fee"`
	} `json:"order_book_details"`
}

type lighterFundings struct {
	Fundings []struct {
		MarketID int     `json:"market_id"`
		Rate     float64 `json:"rate"`     // per-period, signed
		Period   int64   `json:"period"`   // seconds
	} `json:"fundings"`
}

type lighterOrders struct {
	Asks []struct {
		Price                string `json:"price"`
		RemainingBaseAmount  string `json:"remaining_base_amount"`
	} `json:"asks"`
	Bids []struct {
		Price                string `json:"price"`
		RemainingBaseAmount  string `json:"remaining_base_amount"`
	} `json:"bids"`
}

func fetchLighter(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	// 1) Markets — find ETH market and read fee + funding
	var markets lighterMarketDetails
	if err := lighterGet(client, lighterBase+"/orderBookDetails", &markets); err != nil {
		s.Err = fmt.Sprintf("markets: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	var marketID int = -1
	for _, m := range markets.OrderBookDetails {
		if m.Symbol == v.Asset && m.MarketType == "perp" && m.Status == "active" {
			marketID = m.MarketID
			takerPct, _ := strconv.ParseFloat(m.TakerFee, 64)
			s.TakerFeeBps = takerPct * 100 // pct → bps
			break
		}
	}
	if marketID < 0 {
		s.Err = "asset_not_found"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	// 2) Orderbook for that market
	var book lighterOrders
	if err := lighterGet(client, fmt.Sprintf("%s/orderBookOrders?market_id=%d&limit=50", lighterBase, marketID), &book); err != nil {
		s.Err = fmt.Sprintf("orderbook: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(book.Bids) == 0 || len(book.Asks) == 0 {
		s.Err = "empty_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	bestBid, _ := strconv.ParseFloat(book.Bids[0].Price, 64)
	bestAsk, _ := strconv.ParseFloat(book.Asks[0].Price, 64)
	mid := (bestBid + bestAsk) / 2
	s.MidPrice = mid

	// Walk asks
	levels := make([]bookLevel, 0, len(book.Asks))
	for _, a := range book.Asks {
		px, _ := strconv.ParseFloat(a.Price, 64)
		sz, _ := strconv.ParseFloat(a.RemainingBaseAmount, 64)
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
	// Notional tiers: rewalk the already-fetched book (top 50 levels) at
	// $1k/$10k/$100k. Tiers the fetched depth cannot fill are skipped
	// (counted), never extrapolated.
	applyBookTiers(&s, levels, mid)
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func lighterGet(client *http.Client, url string, out any) error {
	resp, err := client.Get(url)
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
