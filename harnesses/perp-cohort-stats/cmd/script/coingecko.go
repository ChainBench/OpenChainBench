package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// CoinGecko derivatives-exchanges list, shared by the venues that have
// no public stats endpoint of their own (SynFutures, KiloEx). The free
// tier allows roughly 10 calls a minute per IP and the harness ticks
// every 60 s, so two sources each calling it per tick spent a fifth of
// their ticks on 429 (about 300 rate_limit errors a day each in
// 2026-09). One call, cached cgListTTL, feeds both; a 429 or any other
// failure serves the previous list while it is younger than cgStaleMax.
//
//	GET https://api.coingecko.com/api/v3/derivatives/exchanges?per_page=250&page=1
//
// trade_volume_24h_btc is the exchange's 24 h taker notional in BTC;
// callers convert with the Hyperliquid BTC mid (fetchBTCPrice).
const (
	cgListURL  = "https://api.coingecko.com/api/v3/derivatives/exchanges?per_page=250&page=1"
	cgListTTL  = 10 * time.Minute
	cgStaleMax = 2 * time.Hour
)

type cgExchangeListItem struct {
	ID                string  `json:"id"`
	TradeVolume24hBTC float64 `json:"trade_volume_24h_btc,string"`
}

var cgList struct {
	mu      sync.Mutex
	items   []cgExchangeListItem
	fetched time.Time
	client  *http.Client
}

// cgDerivativesExchanges returns the cached list, refreshing it when it
// is older than cgListTTL. stale is true when the refresh failed and a
// list younger than cgStaleMax is served instead, so callers can count
// the miss; the error is non-nil only when nothing usable is cached.
func cgDerivativesExchanges() (items []cgExchangeListItem, stale bool, err error) {
	cgList.mu.Lock()
	defer cgList.mu.Unlock()
	if cgList.client == nil {
		cgList.client = &http.Client{Timeout: 15 * time.Second}
	}
	age := time.Since(cgList.fetched)
	if cgList.items != nil && age < cgListTTL {
		return cgList.items, false, nil
	}
	req, _ := http.NewRequest("GET", cgListURL, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
	req.Header.Set("Accept", "application/json")
	resp, doErr := cgList.client.Do(req)
	err = doErr
	if err == nil {
		defer resp.Body.Close()
		body, readErr := io.ReadAll(resp.Body)
		switch {
		case readErr != nil:
			err = readErr
		case resp.StatusCode != 200:
			snippet := string(body)
			if len(snippet) > 100 {
				snippet = snippet[:100]
			}
			err = fmt.Errorf("http %d: %s", resp.StatusCode, snippet)
		default:
			var fresh []cgExchangeListItem
			if err = json.Unmarshal(body, &fresh); err == nil && len(fresh) > 0 {
				cgList.items = fresh
				cgList.fetched = time.Now()
				return fresh, false, nil
			}
			if err == nil {
				err = fmt.Errorf("empty list")
			}
		}
	}
	if cgList.items != nil && age < cgStaleMax {
		fmt.Printf("[perp-cohort][coingecko] refresh failed (%v), serving %s old list\n", err, age.Round(time.Second))
		return cgList.items, true, nil
	}
	return nil, false, err
}

// cgVolume24hBTC returns the summed 24 h BTC volume of the given
// exchange ids, how many of them were present in the list, and whether
// the list is a stale copy served after a failed refresh.
func cgVolume24hBTC(ids map[string]bool) (float64, int, bool, error) {
	items, stale, err := cgDerivativesExchanges()
	if err != nil {
		return 0, 0, false, err
	}
	var total float64
	var found int
	for _, ex := range items {
		if ids[ex.ID] {
			total += ex.TradeVolume24hBTC
			found++
		}
	}
	return total, found, stale, nil
}
