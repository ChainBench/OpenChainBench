package main

// source_gmx.go: GMX v2 on Arbitrum.
//
// OI: GET arbitrum-api.gmxinfra.io/markets/info: sums openInterestLong +
// openInterestShort across all isListed markets whose name matches the asset
// (e.g. "ETH/USD [ETH-USDC]" + "ETH/USD [ETH-ETH]" for ETH). Values are
// 30-decimal USD strings; divided by 1e30 to get USD.
//
// Liquidations: from the public Subsquid squid the cohort harness already
// reads, which does expose the order type. This spec claimed until
// 2026-09-27 that no source existed because "Subsquid positionChanges does
// not expose an orderType or isLiquidation flag". That is true of
// positionChanges and false of tradeActions, whose orderType is 7 for a
// liquidation. Re-checked on 2026-09-27: 103 executed liquidations in 24h
// across every market, $900,656 of notional, of which ETH $276,827 and BTC
// $145,148. There is no REST liquidation endpoint on gmxinfra (/liquidations,
// /actions, /trades all 404), so the squid is the only path.
//
// Every liquidation appears in tradeActions twice, once as OrderCreated and
// once as OrderExecuted, so eventName has to be pinned or the figure doubles.

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	gmxMarketsInfoURL = "https://arbitrum-api.gmxinfra.io/markets/info"
	gmxMarketsTTL     = 4 * time.Minute
	// The squid the cohort harness reads (harnesses/perp-cohort-stats).
	gmxSquidURL = "https://gmx.squids.live/gmx-synthetics-arbitrum/graphql"
	// Order.OrderType: 7 is Liquidation. 2 and above are the position
	// orders, so orderType_gte 2 is the venue's own executed notional and
	// excludes the plain swap types 0 and 1.
	gmxOrderTypeLiquidation = 7
	gmxOrderTypeFirstPos    = 2
	gmxSquidPageLimit       = 500
	gmxSquidMaxPages        = 20
	// The 24h volume query pages over a few thousand rows, so it is re-read
	// on a timer rather than on every 5-minute tick.
	gmxVolumeTTL = 15 * time.Minute
)

// gmxTrackedAssets lists the assets supported by this source.
var gmxTrackedAssets = map[string]bool{"ETH": true, "BTC": true}

// GMX implements Source with a small cached /markets/info snapshot.
type GMX struct {
	marketsURL string // defaults to gmxMarketsInfoURL
	squidURL   string // defaults to gmxSquidURL

	mu        sync.Mutex
	markets   []gmxMarket
	marketsAt time.Time
	// volMu is held across the whole volume refresh, so the ETH and BTC
	// goroutines that miss the cache on the same tick page the squid once
	// between them rather than once each.
	volMu    sync.Mutex
	volume   map[string]float64
	volumeAt time.Time
}

// NewGMX returns the GMX source.
func NewGMX() *GMX {
	return &GMX{marketsURL: gmxMarketsInfoURL, squidURL: gmxSquidURL}
}

type gmxMarket struct {
	Name              string `json:"name"`
	MarketToken       string `json:"marketToken"`
	IsListed          bool   `json:"isListed"`
	OpenInterestLong  string `json:"openInterestLong"`  // 30-decimal USD
	OpenInterestShort string `json:"openInterestShort"` // 30-decimal USD
}

func (g *GMX) fetchMarkets() ([]gmxMarket, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.markets != nil && time.Since(g.marketsAt) < gmxMarketsTTL {
		return g.markets, nil
	}
	var resp struct {
		Markets []gmxMarket `json:"markets"`
	}
	if err := httpGetJSON(g.marketsURL, &resp); err != nil {
		return nil, fmt.Errorf("gmx markets: %w", err)
	}
	if len(resp.Markets) == 0 {
		return nil, fmt.Errorf("gmx markets: empty market list")
	}
	g.markets = resp.Markets
	g.marketsAt = time.Now()
	return g.markets, nil
}

// gmxAssetMatches reports whether the asset appears as the leading token of
// the market name (before the first "/" or space), preventing "WETH/..." from
// matching "ETH" while still matching "ETH/USD [WETH-USDC]" and similar.
func gmxAssetMatches(marketName, asset string) bool {
	upper := strings.ToUpper(strings.TrimSpace(marketName))
	a := strings.ToUpper(asset)
	return upper == a ||
		strings.HasPrefix(upper, a+"/") ||
		strings.HasPrefix(upper, a+" ") ||
		strings.HasPrefix(upper, a+"-")
}

// HasLiquidationSource reports true: the squid's tradeActions carries the
// order type, and 7 is a liquidation.
func (g *GMX) HasLiquidationSource() bool { return true }

// gmxTradeAction is one row of the squid's tradeActions.
type gmxTradeAction struct {
	MarketAddress   string `json:"marketAddress"`
	SizeDeltaUsd    string `json:"sizeDeltaUsd"` // 30-decimal USD
	Timestamp       int64  `json:"timestamp"`    // unix seconds
	TransactionHash string `json:"transactionHash"`
	OrderKey        string `json:"orderKey"`
}

// squidTradeActions pages tradeActions under one where clause. Rows are
// deduplicated by orderKey: the squid is live and ordered newest first, so a
// row inserted between two pages shifts the next page down and repeats the
// tail of the previous one. Hitting the page cap hands back the rows read
// with a partialWindowError naming the oldest of them; the liquidation
// caller folds those in and holds the rank, the volume caller refuses the
// partial sum because it feeds the rank gate's denominator.
func (g *GMX) squidTradeActions(where string) ([]gmxTradeAction, error) {
	var all []gmxTradeAction
	seen := make(map[string]bool, 1024)
	oldestRead := int64(0)
	page := 0
	for ; page < gmxSquidMaxPages; page++ {
		q := fmt.Sprintf(
			`{ tradeActions(where:{%s}, orderBy:timestamp_DESC, limit:%d, offset:%d) `+
				`{ marketAddress sizeDeltaUsd timestamp transactionHash orderKey } }`,
			where, gmxSquidPageLimit, page*gmxSquidPageLimit)
		var resp struct {
			Data struct {
				TradeActions []gmxTradeAction `json:"tradeActions"`
			} `json:"data"`
			Errors []struct {
				Message string `json:"message"`
			} `json:"errors"`
		}
		if err := httpPostJSON(g.squidURL, map[string]any{"query": q}, &resp); err != nil {
			return nil, fmt.Errorf("gmx squid: %w", err)
		}
		if len(resp.Errors) > 0 {
			return nil, fmt.Errorf("gmx squid: %s", resp.Errors[0].Message)
		}
		for _, r := range resp.Data.TradeActions {
			id := r.OrderKey
			if id == "" {
				id = r.TransactionHash + ":" + r.MarketAddress + ":" + fmt.Sprint(r.Timestamp)
			}
			if seen[id] {
				continue
			}
			seen[id] = true
			all = append(all, r)
			if oldestRead == 0 || r.Timestamp < oldestRead {
				oldestRead = r.Timestamp
			}
		}
		if len(resp.Data.TradeActions) < gmxSquidPageLimit {
			return all, nil
		}
	}
	return all, &partialWindowError{OldestReadMs: oldestRead * 1000, Cap: gmxSquidMaxPages * gmxSquidPageLimit, What: "gmx squid tradeActions"}
}

// marketAsset maps a market token address to the asset it trades. The index
// token comes first in the market name, so "XRP/USD [ETH-USDC]" is an XRP
// market collateralised in ETH and must not be read as ETH.
func (g *GMX) marketAsset() (map[string]string, error) {
	markets, err := g.fetchMarkets()
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(markets))
	for _, m := range markets {
		out[strings.ToLower(m.MarketToken)] = gmxIndexToken(m.Name)
	}
	return out, nil
}

// gmxIndexToken is the index token of a market name: the part before the
// first separator, under the same rule gmxAssetMatches applies for OI, so the
// numerator, the denominator and the open interest cover one market set.
func gmxIndexToken(marketName string) string {
	name := strings.ToUpper(strings.TrimSpace(marketName))
	if i := strings.IndexAny(name, "/ -"); i > 0 {
		name = name[:i]
	}
	return name
}

// FetchLiquidationsSince returns executed liquidations of the asset since
// sinceMs. sizeDeltaUsd is already USD at execution, at 30 decimals, so no
// price lookup is needed.
func (g *GMX) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	if !gmxTrackedAssets[asset] {
		return nil, fmt.Errorf("gmx: unsupported asset %q", asset)
	}
	byMarket, err := g.marketAsset()
	if err != nil {
		return nil, err
	}
	where := fmt.Sprintf(`orderType_eq:%d, eventName_eq:"OrderExecuted", timestamp_gte:%d`,
		gmxOrderTypeLiquidation, sinceMs/1000)
	rows, err := g.squidTradeActions(where)
	var partial *partialWindowError
	if err != nil && !errors.As(err, &partial) {
		return nil, err
	}
	want := strings.ToUpper(asset)
	var events []LiqEvent
	for _, r := range rows {
		if byMarket[strings.ToLower(r.MarketAddress)] != want {
			continue
		}
		usd, err := parseScaled(r.SizeDeltaUsd, 30)
		if err != nil || usd <= 0 {
			continue
		}
		key := r.OrderKey
		if key == "" {
			key = fmt.Sprintf("%s:%s:%d", r.TransactionHash, r.MarketAddress, r.Timestamp)
		}
		events = append(events, LiqEvent{
			Key:         "gmx:" + key,
			NotionalUSD: usd,
			TimestampMs: r.Timestamp * 1000,
		})
	}
	// err is nil or the partialWindowError, which travels with the rows.
	return events, err
}

// FetchVolume24hUSD returns the asset's executed position notional over the
// trailing 24h, summed from the same squid the numerator comes from, so the
// plausibility test compares two figures with one definition behind them.
// Cached for gmxVolumeTTL because the query pages over a few thousand rows.
func (g *GMX) FetchVolume24hUSD(asset string) (float64, error) {
	if !gmxTrackedAssets[asset] {
		return 0, fmt.Errorf("gmx: unsupported asset %q", asset)
	}
	g.volMu.Lock()
	defer g.volMu.Unlock()
	if g.volume != nil && time.Since(g.volumeAt) < gmxVolumeTTL {
		return g.volume[strings.ToUpper(asset)], nil
	}

	byMarket, err := g.marketAsset()
	if err != nil {
		return 0, err
	}
	since := time.Now().Add(-windowSpan).Unix()
	where := fmt.Sprintf(`orderType_gte:%d, eventName_eq:"OrderExecuted", timestamp_gte:%d`,
		gmxOrderTypeFirstPos, since)
	rows, err := g.squidTradeActions(where)
	if err != nil {
		return 0, err
	}
	totals := make(map[string]float64, 8)
	for _, r := range rows {
		a := byMarket[strings.ToLower(r.MarketAddress)]
		if a == "" {
			continue
		}
		usd, err := parseScaled(r.SizeDeltaUsd, 30)
		if err != nil || usd <= 0 {
			continue
		}
		totals[a] += usd
	}
	g.volume, g.volumeAt = totals, time.Now()
	return totals[strings.ToUpper(asset)], nil
}

// FetchOI sums openInterestLong + openInterestShort across all listed markets
// that match the asset, converting from 30-decimal fixed-point USD to float64.
func (g *GMX) FetchOI(asset string) (float64, error) {
	if !gmxTrackedAssets[asset] {
		return 0, fmt.Errorf("gmx: unsupported asset %q", asset)
	}
	markets, err := g.fetchMarkets()
	if err != nil {
		return 0, err
	}

	var totalOI float64
	matched := false
	for _, m := range markets {
		if !m.IsListed || !gmxAssetMatches(m.Name, asset) {
			continue
		}
		matched = true
		if m.OpenInterestLong != "" {
			v, err := parseScaled(m.OpenInterestLong, 30)
			if err == nil {
				totalOI += v
			}
		}
		if m.OpenInterestShort != "" {
			v, err := parseScaled(m.OpenInterestShort, 30)
			if err == nil {
				totalOI += v
			}
		}
	}
	if !matched {
		return 0, fmt.Errorf("gmx: no listed markets found for %q", asset)
	}
	// One-sided, like every order-book venue in the cohort: GMX reports long
	// and short separately, and their sum would read twice the exposure a
	// book reports for the same positions.
	return totalOI / 2, nil
}
