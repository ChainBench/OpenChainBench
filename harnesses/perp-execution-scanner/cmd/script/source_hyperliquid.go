package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// FetchHyperliquid pulls an L2 orderbook snapshot from Hyperliquid's
// public info endpoint for a HIP-3 deployer-scoped coin (e.g. "xyz:BOT"):
//
//   POST https://api.hyperliquid.xyz/info
//   Content-Type: application/json
//   {"type":"l2Book","coin":"xyz:BOT"}
//
// Response shape: `{"coin":"xyz:BOT","time":..., "levels":[[bids...],
// [asks...]]}` with each level as `{"px":"37.5","sz":"1.5","n":1}`. Bids
// come back descending, asks ascending; matches our OrderBook contract.
//
// No auth. Documented rate limit is 1200 requests/minute across all info
// calls; a single POST per tick per asset is trivial.
const hyperliquidInfoURL = "https://api.hyperliquid.xyz/info"

type hlLevel struct {
	Px string `json:"px"`
	Sz string `json:"sz"`
}

type hlL2BookResp struct {
	Coin   string      `json:"coin"`
	Time   int64       `json:"time"`
	Levels [][]hlLevel `json:"levels"`
}

func FetchHyperliquid(asset string, coin string) (*OrderBook, error) {
	body, err := json.Marshal(map[string]any{"type": "l2Book", "coin": coin})
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("POST", hyperliquidInfoURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-PerpExecutionScanner/1.0 contact@openchainbench.com")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	var r hlL2BookResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	if len(r.Levels) < 2 {
		return nil, fmt.Errorf("bad_shape: levels len=%d", len(r.Levels))
	}
	book := &OrderBook{
		Venue:    "hyperliquid",
		Asset:    asset,
		Bids:     parseHLSide(r.Levels[0]),
		Asks:     parseHLSide(r.Levels[1]),
		ScrapeTs: time.Now().Unix(),
	}
	return book, nil
}

func parseHLSide(rows []hlLevel) []Level {
	out := make([]Level, 0, len(rows))
	for _, o := range rows {
		px, err1 := strconv.ParseFloat(o.Px, 64)
		sz, err2 := strconv.ParseFloat(o.Sz, 64)
		if err1 != nil || err2 != nil || px <= 0 || sz <= 0 {
			continue
		}
		out = append(out, Level{Price: px, Size: sz})
	}
	return out
}
