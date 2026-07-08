package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// dYdX v4: indexer for orderbook + funding, Cosmos REST for the on-chain
// fee tier table. Both unauthenticated.

const dydxIndexerBase = "https://indexer.dydx.trade/v4"
const dydxChainREST = "https://dydx-rest.publicnode.com"

type dydxOrderbook struct {
	Bids []struct {
		Price string `json:"price"`
		Size  string `json:"size"`
	} `json:"bids"`
	Asks []struct {
		Price string `json:"price"`
		Size  string `json:"size"`
	} `json:"asks"`
}

type dydxMarket struct {
	Markets map[string]struct {
		NextFundingRate string `json:"nextFundingRate"`
	} `json:"markets"`
}

type dydxFeeTier struct {
	TakerFeePpm int64 `json:"taker_fee_ppm"`
	MakerFeePpm int64 `json:"maker_fee_ppm"`
}

type dydxFeeParams struct {
	Params struct {
		Tiers []dydxFeeTier `json:"tiers"`
	} `json:"params"`
}

func fetchDYdX(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	ticker := v.Asset + "-USD"

	// 1) Orderbook
	var book dydxOrderbook
	if err := dydxGet(client, dydxIndexerBase+"/orderbooks/perpetualMarket/"+ticker, &book); err != nil {
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

	// 2) Funding rate
	var market dydxMarket
	if err := dydxGet(client, dydxIndexerBase+"/perpetualMarkets?ticker="+ticker, &market); err == nil {
		if m, ok := market.Markets[ticker]; ok {
			f, _ := strconv.ParseFloat(m.NextFundingRate, 64)
			s.FundingRatePerHrBps = f * 10000
		}
	}

	// 3) Fee tier from chain REST. Hard requirement: if this fails the
	// all-in number would silently miss the taker fee, so we error out and
	// skip publishing this cycle instead.
	var feeParams dydxFeeParams
	if err := dydxGet(client, dydxChainREST+"/dydxprotocol/v4/feetiers/perpetual_fee_params", &feeParams); err != nil {
		s.Err = fmt.Sprintf("feetiers: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(feeParams.Params.Tiers) == 0 {
		s.Err = "feetiers_empty"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	// Tier 0 is the default for any user not in higher tiers
	t0 := feeParams.Params.Tiers[0]
	// ppm = parts per million; bps = ppm / 100
	s.TakerFeeBps = float64(t0.TakerFeePpm) / 100.0

	s.AllInBps = s.TakerFeeBps + s.SpreadBps
	// Notional tiers: rewalk the already-fetched book at $1k/$10k/$100k.
	// The indexer book is depth-limited; tiers the book cannot fill are
	// skipped (counted), not extrapolated.
	applyBookTiers(&s, levels, mid)
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func dydxGet(client *http.Client, url string, out any) error {
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
