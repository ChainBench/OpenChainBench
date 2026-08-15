package main

// source_gmx.go — GMX v2 on Arbitrum.
//
// OI: GET arbitrum-api.gmxinfra.io/markets/info — sums openInterestLong +
// openInterestShort across all isListed markets whose name matches the asset
// (e.g. "ETH/USD [ETH-USDC]" + "ETH/USD [ETH-ETH]" for ETH). Values are
// 30-decimal USD strings; divided by 1e30 to get USD. ✓
// Liquidations: the TheGraph gmx-v2 subgraph is defunct; no alternative
// public source found. FetchLiquidationsSince returns empty; liq_rate = 0.

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	gmxMarketsInfoURL = "https://arbitrum-api.gmxinfra.io/markets/info"
	gmxMarketsTTL     = 4 * time.Minute
)

// gmxTrackedAssets lists the assets supported by this source.
var gmxTrackedAssets = map[string]bool{"ETH": true, "BTC": true}

// GMX implements Source with a small cached /markets/info snapshot.
type GMX struct {
	marketsURL string // defaults to gmxMarketsInfoURL

	mu        sync.Mutex
	markets   []gmxMarket
	marketsAt time.Time
}

// NewGMX returns the GMX source.
func NewGMX() *GMX {
	return &GMX{marketsURL: gmxMarketsInfoURL}
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

// FetchLiquidationsSince returns empty — no public GMX V2 liquidation source
// is available (TheGraph subgraph defunct, no REST alternative found).
func (g *GMX) FetchLiquidationsSince(asset string, _ int64) ([]LiqEvent, error) {
	if !gmxTrackedAssets[asset] {
		return nil, fmt.Errorf("gmx: unsupported asset %q", asset)
	}
	return nil, nil
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
	return totalOI, nil
}
