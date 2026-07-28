package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// edgeX (offchain CLOB perp DEX). Public no-auth REST. Contract IDs are
// resolved via GET /api/v1/public/meta/getMetaData; hardcoded here after a
// one-time lookup (verified via getMetaData on 2026-07-16). The taker fee
// is not exposed by any public endpoint: the documented base rate
// (3.8 bps, edgex-1.gitbook.io) is used and disclosed in the spec formula.
// TODO: switch to fee schedule API when edgeX ships one.

const edgexBase = "https://pro.edgex.exchange"

// Documented base taker rate (3.8 bps = 0.00038). Revisit if edgeX ships a
// public fees endpoint.
const edgexTakerBps = 3.8

// Asset → contractId map. Verified via getMetaData on 2026-07-16. If edgeX
// re-numbers contracts, update these IDs (or wire in a dynamic lookup).
var edgexContractIDs = map[string]string{
	"ETH": "10000002",
	"BTC": "10000001",
	"SOL": "10000003",
}

type edgexDepthResp struct {
	Code string `json:"code"`
	Data []struct {
		Bids []struct {
			Price string `json:"price"`
			Size  string `json:"size"`
		} `json:"bids"`
		Asks []struct {
			Price string `json:"price"`
			Size  string `json:"size"`
		} `json:"asks"`
	} `json:"data"`
	Msg string `json:"msg"`
}

func fetchEdgex(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	contractID, ok := edgexContractIDs[v.Asset]
	if !ok {
		s.Err = "asset_not_mapped"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.TakerFeeBps = edgexTakerBps

	var book edgexDepthResp
	url := fmt.Sprintf("%s/api/v1/public/quote/getDepth?contractId=%s&level=200", edgexBase, contractID)
	if err := edgexGet(client, url, &book); err != nil {
		s.Err = fmt.Sprintf("orderbook: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(book.Data) == 0 {
		s.Err = "empty_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	d := book.Data[0]
	if len(d.Bids) == 0 || len(d.Asks) == 0 {
		s.Err = "empty_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	bestBid, _ := strconv.ParseFloat(d.Bids[0].Price, 64)
	bestAsk, _ := strconv.ParseFloat(d.Asks[0].Price, 64)
	mid := (bestBid + bestAsk) / 2
	if mid <= 0 {
		s.Err = "bad_mid"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.MidPrice = mid

	levels := make([]bookLevel, 0, len(d.Asks))
	for _, a := range d.Asks {
		px, _ := strconv.ParseFloat(a.Price, 64)
		sz, _ := strconv.ParseFloat(a.Size, 64)
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

func edgexGet(client *http.Client, url string, out any) error {
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
