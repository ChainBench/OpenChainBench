package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Aster (BSC-based perp DEX, Binance-style REST). Public no-auth REST for
// the depth endpoint; symbol convention is uppercase USDT-quoted
// (ETHUSDT, BTCUSDT, SOLUSDT). The taker fee is not exposed by any public
// endpoint: the documented base rate (5 bps, docs.asterdex.com) is used
// and disclosed in the spec formula.
// TODO: switch to fee schedule API when Aster ships one.

const asterBase = "https://fapi.asterdex.com"

// Documented base taker rate (5 bps = 0.0005). Revisit if Aster ships a
// public fees endpoint.
const asterTakerBps = 5.0

type asterDepth struct {
	Bids [][]string `json:"bids"` // [price, qty]
	Asks [][]string `json:"asks"`
}

func fetchAster(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	symbol := v.Asset + "USDT"
	s.TakerFeeBps = asterTakerBps

	var book asterDepth
	url := fmt.Sprintf("%s/fapi/v1/depth?symbol=%s&limit=100", asterBase, symbol)
	if err := asterGet(client, url, &book); err != nil {
		s.Err = fmt.Sprintf("orderbook: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(book.Bids) == 0 || len(book.Asks) == 0 {
		s.Err = "empty_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(book.Bids[0]) < 2 || len(book.Asks[0]) < 2 {
		s.Err = "malformed_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	bestBid, _ := strconv.ParseFloat(book.Bids[0][0], 64)
	bestAsk, _ := strconv.ParseFloat(book.Asks[0][0], 64)
	mid := (bestBid + bestAsk) / 2
	if mid <= 0 {
		s.Err = "bad_mid"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.MidPrice = mid

	levels := make([]bookLevel, 0, len(book.Asks))
	for _, a := range book.Asks {
		if len(a) < 2 {
			continue
		}
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

	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func asterGet(client *http.Client, url string, out any) error {
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
