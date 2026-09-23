package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// edgeX (offchain CLOB perp DEX). Public no-auth REST, v2 API since
// 2026-09-22: the v1 host (pro.edgex.exchange/api/v1) kept answering 200
// with an empty data array on every quote endpoint, which the harness
// read as empty_orderbook on all three assets for weeks. Contract IDs
// are resolved via GET /api/v2/public/meta/getMetaData; hardcoded here
// after a lookup on 2026-09-22 (v2 renumbered them to 30000xxx). The
// fee schedule IS exposed, on getMetaData: each contract carries
// defaultTakerFeeRate and defaultMakerFeeRate. The harness used to pin the
// taker at the documented 3.8 bps; it now reads both, which makes the rate
// self-correcting and gives the fee band its floor (2026-09-23).

const edgexBase = "https://edgex-prod-v2.edgex.exchange"

// Fallback for the tick where getMetaData is unreachable: the documented
// base rate. A wrong-but-documented taker beats no row at all, and the
// maker simply stays absent, which is what "we could not read it" should
// look like.
const edgexTakerBpsFallback = 3.8

type edgexMetaResp struct {
	Data struct {
		ContractList []struct {
			ContractID          string `json:"contractId"`
			DefaultTakerFeeRate string `json:"defaultTakerFeeRate"`
			DefaultMakerFeeRate string `json:"defaultMakerFeeRate"`
		} `json:"contractList"`
	} `json:"data"`
}

// edgexFeeRates reads the published schedule for one contract. Returns
// ok=false when the call fails or the contract is absent, and the caller
// then falls back to the documented taker with no maker.
func edgexFeeRates(client *http.Client, contractID string) (taker, maker float64, ok bool) {
	var meta edgexMetaResp
	url := fmt.Sprintf("%s/api/v2/public/meta/getMetaData", edgexBase)
	if err := edgexGet(client, url, &meta); err != nil {
		return 0, 0, false
	}
	for _, c := range meta.Data.ContractList {
		if c.ContractID != contractID {
			continue
		}
		t, errT := strconv.ParseFloat(c.DefaultTakerFeeRate, 64)
		m, errM := strconv.ParseFloat(c.DefaultMakerFeeRate, 64)
		if errT != nil || t <= 0 {
			return 0, 0, false
		}
		if errM != nil {
			return t * 10000, 0, false
		}
		return t * 10000, m * 10000, true
	}
	return 0, 0, false
}

// Asset → contractId map. Verified via v2 getMetaData on 2026-09-22
// (BTCUSDC, ETHUSDC, SOLUSDC). If edgeX re-numbers contracts again,
// update these IDs (or wire in a dynamic lookup).
var edgexContractIDs = map[string]string{
	"ETH": "30000002",
	"BTC": "30000001",
	"SOL": "30000003",
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
	if taker, maker, ok := edgexFeeRates(client, contractID); ok {
		s.TakerFeeBps = taker
		s.MakerFeeBps, s.HasMakerFee = maker, true
	} else {
		s.TakerFeeBps = edgexTakerBpsFallback
	}

	var book edgexDepthResp
	url := fmt.Sprintf("%s/api/v2/public/quote/getDepth?contractId=%s&level=200", edgexBase, contractID)
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
	req.Header.Set("User-Agent", "OpenChainBench-PerpFees/1.0 contact@openchainbench.com")
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
