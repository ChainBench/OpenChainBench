package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// CexCoinGeckoSource publishes the large centralised perp books as cohort
// rows (venue type "cex" in the registry) from CoinGecko's derivatives
// exchange list, the same cached call SynFutures and KiloEx read
// (coingecko.go). CEX numbers are what the venue reports to CoinGecko,
// not an OpenChainBench measurement; the hub and the specs label them
// as such, and no bench ranks a CEX against a DEX on volume. They exist
// so the board can show the reference next to the measured rows and so
// the CEX funding rows (Mobula feed) have volume and OI beside them.
//
//	trade_volume_24h_btc x BTC mid  -> volume_24h_usd
//	open_interest_btc x BTC mid     -> oi_usd
//	number_of_perpetual_pairs       -> active_markets
//
// The BTC mid is Hyperliquid's allMids (already used for SynFutures and
// KiloEx), so every CoinGecko-derived dollar figure uses one price.
type CexCoinGeckoSource struct {
	client *http.Client
}

func NewCexCoinGeckoSource() *CexCoinGeckoSource {
	return &CexCoinGeckoSource{client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *CexCoinGeckoSource) Name() string { return srcCexCoinGecko }

// cexCoinGeckoIDs maps the cohort slug (the one the Mobula funding feed
// already uses for these venues) to CoinGecko's derivatives exchange id.
// KuCoin has no derivatives entry on the list; its row stays funding-only.
var cexCoinGeckoIDs = map[string]string{
	"binance":  "binance_futures",
	"okx":      "okex_swap",
	"bybit":    "bybit",
	"gate":     "gate_futures",
	"coinbase": "coinbase_international_derivatives",
	"bitget":   "bitget_futures",
	"deribit":  "deribit",
	"kraken":   "kraken_futures",
	"mexc":     "mxc_futures",
}

func (s *CexCoinGeckoSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	items, stale, err := cgDerivativesExchanges()
	if err != nil {
		for venue := range cexCoinGeckoIDs {
			perpCohortFetchErrors.WithLabelValues(venue, srcCexCoinGecko, classifyError(err.Error())).Inc()
		}
		fmt.Printf("[perp-cohort][cex][%s] err: %v\n", srcCexCoinGecko, err)
		return res, nil
	}
	btc, err := fetchBTCMid(s.client)
	if err != nil {
		for venue := range cexCoinGeckoIDs {
			perpCohortFetchErrors.WithLabelValues(venue, srcCexCoinGecko, classifyError(err.Error())).Inc()
		}
		fmt.Printf("[perp-cohort][cex][%s] btc mid err: %v\n", srcCexCoinGecko, err)
		return res, nil
	}
	byID := map[string]cgExchangeListItem{}
	for _, it := range items {
		byID[it.ID] = it
	}
	var found int
	for venue, id := range cexCoinGeckoIDs {
		it, ok := byID[id]
		if !ok {
			perpCohortFetchErrors.WithLabelValues(venue, srcCexCoinGecko, "not_listed").Inc()
			continue
		}
		found++
		if stale {
			perpCohortFetchErrors.WithLabelValues(venue, srcCexCoinGecko, "stale_cache").Inc()
		}
		res.SetIfPositive(venue, mVolume24h, it.TradeVolume24hBTC*btc)
		res.SetIfPositive(venue, mOI, it.OpenInterestBTC*btc)
		res.SetIfPositive(venue, mActiveMarkets, float64(it.PerpetualPairs))
	}
	fmt.Printf("[perp-cohort][cex][%s] ok: %d/%d venues, btc=%.0f\n", srcCexCoinGecko, found, len(cexCoinGeckoIDs), btc)
	return res, nil
}

// fetchBTCMid reads BTC from Hyperliquid allMids: one price for every
// CoinGecko BTC-denominated figure the harness converts.
func fetchBTCMid(client *http.Client) (float64, error) {
	req, _ := http.NewRequest("POST", "https://api.hyperliquid.xyz/info", strings.NewReader(`{"type":"allMids"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var mids hlAllMidsResp
	if err := json.Unmarshal(body, &mids); err != nil {
		return 0, fmt.Errorf("parse hl allMids: %w", err)
	}
	priceStr, ok := mids["BTC"]
	if !ok {
		return 0, fmt.Errorf("BTC not in hl allMids")
	}
	var price float64
	if _, err := fmt.Sscanf(priceStr, "%f", &price); err != nil {
		return 0, fmt.Errorf("parse btc price %q: %w", priceStr, err)
	}
	return price, nil
}
