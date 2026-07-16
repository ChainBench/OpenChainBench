package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
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

	// Convert and sort. The dYdX v4 indexer's orderbook endpoint returns
	// levels in insertion order, NOT sorted by price — walking as-is means
	// the "top of book" starts at whichever level was most recently posted,
	// which inflates the effective price by a factor that matches the
	// observed 1.7-2x too-high headline (asks walked out of order push the
	// weighted average well past the true best offer). Sort asks ascending
	// and bids descending before consuming.
	asks := make([]bookLevel, 0, len(book.Asks))
	for _, a := range book.Asks {
		px, _ := strconv.ParseFloat(a.Price, 64)
		sz, _ := strconv.ParseFloat(a.Size, 64)
		if px > 0 && sz > 0 {
			asks = append(asks, bookLevel{Px: px, Sz: sz})
		}
	}
	bids := make([]bookLevel, 0, len(book.Bids))
	for _, b := range book.Bids {
		px, _ := strconv.ParseFloat(b.Price, 64)
		sz, _ := strconv.ParseFloat(b.Size, 64)
		if px > 0 && sz > 0 {
			bids = append(bids, bookLevel{Px: px, Sz: sz})
		}
	}
	if len(asks) == 0 || len(bids) == 0 {
		s.Err = "empty_orderbook"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	sort.Slice(asks, func(i, j int) bool { return asks[i].Px < asks[j].Px })
	sort.Slice(bids, func(i, j int) bool { return bids[i].Px > bids[j].Px })

	bestBid := bids[0].Px
	bestAsk := asks[0].Px
	mid := (bestBid + bestAsk) / 2
	s.MidPrice = mid

	// Walk asks (long open = buying against the ask side).
	levels := asks
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
