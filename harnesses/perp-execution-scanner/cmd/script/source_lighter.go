package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// FetchLighter pulls the top-100 orderbook for a market_id from Lighter's
// public zk-rollup info endpoint:
//
//   GET https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders
//       ?market_id={id}&limit=100
//
// The response is `{"asks":[{price, remaining_base_amount, ...}, ...],
// "bids":[...]}`. Asks come back ascending price, bids descending, which
// matches our OrderBook conventions so no re-sorting is needed.
//
// No auth. Public rate limit ~1s; we tick at 30s so we stay well below.
const lighterOrderBookURL = "https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders"

type lighterOrder struct {
	Price               string `json:"price"`
	RemainingBaseAmount string `json:"remaining_base_amount"`
}

type lighterBookResp struct {
	Code  int            `json:"code"`
	Asks  []lighterOrder `json:"asks"`
	Bids  []lighterOrder `json:"bids"`
}

func FetchLighter(asset string, marketID int) (*OrderBook, error) {
	url := fmt.Sprintf("%s?market_id=%d&limit=100", lighterOrderBookURL, marketID)
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpExecutionScanner/1.0 contact@openchainbench.com")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var r lighterBookResp
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	book := &OrderBook{
		Venue:    "lighter",
		Asset:    asset,
		Bids:     parseLighterSide(r.Bids),
		Asks:     parseLighterSide(r.Asks),
		ScrapeTs: time.Now().Unix(),
	}
	return book, nil
}

func parseLighterSide(rows []lighterOrder) []Level {
	out := make([]Level, 0, len(rows))
	for _, o := range rows {
		px, err1 := strconv.ParseFloat(o.Price, 64)
		sz, err2 := strconv.ParseFloat(o.RemainingBaseAmount, 64)
		if err1 != nil || err2 != nil || px <= 0 || sz <= 0 {
			continue
		}
		out = append(out, Level{Price: px, Size: sz})
	}
	return out
}
