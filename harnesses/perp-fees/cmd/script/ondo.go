package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Ondo Perps (ondoperps.xyz): SGX off-chain matching engine, custody on
// Ethereum and Arbitrum, USDC and tokenized stocks as collateral. Public
// no-auth REST at api.ondoperps.xyz. Markets are `<ASSET>-USD.P`.
//
// Fees come from the contract row (takerFee is a decimal, 0.00025 = 2.5 bps
// during the launch promotion, 5 bps base rate per the docs). The depth
// endpoint serves up to 100 levels per side (`depth=100`); a tier the
// visible book cannot fill is skipped (methodology: skip, never extrapolate).
const ondoBase = "https://api.ondoperps.xyz/v1/perps"

type ondoContracts struct {
	Success bool `json:"success"`
	Result  []struct {
		Market      string `json:"market"`
		TakerFee    string `json:"takerFee"`
		FundingRate string `json:"fundingRate"` // hourly, decimal
		Disabled    bool   `json:"disabled"`
	} `json:"result"`
}

type ondoDepth struct {
	Success bool `json:"success"`
	Result  struct {
		Asks [][2]string `json:"asks"`
		Bids [][2]string `json:"bids"`
	} `json:"result"`
}

func fetchOndo(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}
	market := v.Asset + "-USD.P"

	// 1) Taker fee and funding from the contract row.
	var cs ondoContracts
	if err := ondoGet(client, ondoBase+"/contracts", &cs); err != nil {
		s.Err = fmt.Sprintf("contracts: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	found := false
	for _, c := range cs.Result {
		if c.Market != market {
			continue
		}
		if c.Disabled {
			s.Err = "market_disabled"
			s.FetchLatencyMs = time.Since(start).Milliseconds()
			return s
		}
		fee, _ := strconv.ParseFloat(c.TakerFee, 64)
		s.TakerFeeBps = fee * 10000
		if r, err := strconv.ParseFloat(c.FundingRate, 64); err == nil {
			s.FundingRatePerHrBps = r * 10000 // already per hour
		}
		found = true
		break
	}
	if !found {
		s.Err = "asset_not_found"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	// 2) Order book depth.
	var book ondoDepth
	if err := ondoGet(client, fmt.Sprintf("%s/depth?market=%s&depth=100", ondoBase, market), &book); err != nil {
		s.Err = fmt.Sprintf("depth: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(book.Result.Bids) == 0 || len(book.Result.Asks) == 0 {
		s.Err = "empty_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	bestBid, _ := strconv.ParseFloat(book.Result.Bids[0][0], 64)
	bestAsk, _ := strconv.ParseFloat(book.Result.Asks[0][0], 64)
	mid := (bestBid + bestAsk) / 2
	s.MidPrice = mid
	levels := make([]bookLevel, 0, len(book.Result.Asks))
	for _, a := range book.Result.Asks {
		px, _ := strconv.ParseFloat(a[0], 64)
		sz, _ := strconv.ParseFloat(a[1], 64)
		levels = append(levels, bookLevel{Px: px, Sz: sz})
	}
	// Same 90 % fill cap as Paradex: a tier that eats the whole snapshot
	// is skipped rather than priced off the tail levels.
	const ondoMaxFillRatio = 0.9
	effective, err := walkBookForNotionalCapped(levels, v.NotionalUSD, ondoMaxFillRatio)
	if err != nil {
		s.Err = fmt.Sprintf("walk: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.SpreadBps = (effective - mid) / mid * 10000
	s.AllInBps = s.TakerFeeBps + s.SpreadBps
	applyBookTiersCapped(&s, levels, mid, ondoMaxFillRatio)
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func ondoGet(client *http.Client, url string, out any) error {
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
