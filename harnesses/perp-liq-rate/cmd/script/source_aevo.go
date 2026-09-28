package main

// source_aevo.go: Aevo.
//
// Liquidations: Aevo has no public liquidation feed as of 2025-08;
// FetchLiquidationsSince returns empty with no error.
// OI: GET /statistics?asset=<BASE>&instrument_type=PERPETUAL →
// open_interest.total (contracts) * mark_price (USD/contract).

import (
	"fmt"
	"strings"
)

const aevoBaseURL = "https://api.aevo.xyz"

var aevoInstruments = map[string]string{
	"ETH": "ETH-PERP",
	"BTC": "BTC-PERP",
}

// Aevo implements Source.
type Aevo struct {
	baseURL string // defaults to aevoBaseURL
}

// NewAevo returns the Aevo source.
func NewAevo() *Aevo { return &Aevo{baseURL: aevoBaseURL} }

// HasLiquidationSource reports false: Aevo has no public liquidation feed.
// liq_rate is not published (N/A, not 0%).
func (a *Aevo) HasLiquidationSource() bool { return false }

// FetchLiquidationsSince returns empty: Aevo has no public liquidation feed.
func (a *Aevo) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	if _, ok := aevoInstruments[asset]; !ok {
		return nil, fmt.Errorf("aevo: unsupported asset %q", asset)
	}
	return nil, nil
}

// aevoStats is the /statistics response for one asset's perpetual.
// open_interest.total is in contract units (ETH, BTC), mark_price the USD
// price, and daily_volume is already quote-denominated: on 2026-09-27 ETH
// read daily_volume 471621.24 against daily_volume_contracts 175.05 at a
// mark of 2684.67, which is the same number, so daily_volume is the USD one.
type aevoStats struct {
	OpenInterest struct {
		Total flexFloat `json:"total"`
	} `json:"open_interest"`
	MarkPrice   flexFloat `json:"mark_price"`
	DailyVolume flexFloat `json:"daily_volume"`
}

func (a *Aevo) stats(asset string) (aevoStats, error) {
	instrument, ok := aevoInstruments[asset]
	if !ok {
		return aevoStats{}, fmt.Errorf("aevo: unsupported asset %q", asset)
	}
	base := strings.TrimSuffix(instrument, "-PERP")
	var resp aevoStats
	u := fmt.Sprintf("%s/statistics?asset=%s&instrument_type=PERPETUAL", a.baseURL, base)
	if err := httpGetJSON(u, &resp); err != nil {
		return aevoStats{}, fmt.Errorf("aevo statistics: %w", err)
	}
	return resp, nil
}

// FetchOI returns open interest in USD from /statistics.
func (a *Aevo) FetchOI(asset string) (float64, error) {
	s, err := a.stats(asset)
	if err != nil {
		return 0, err
	}
	markPrice := float64(s.MarkPrice)
	if markPrice == 0 {
		return 0, fmt.Errorf("aevo statistics: mark_price is zero")
	}
	return float64(s.OpenInterest.Total) * markPrice, nil
}

// FetchVolume24hUSD returns the perpetual's 24h traded notional in USD.
func (a *Aevo) FetchVolume24hUSD(asset string) (float64, error) {
	s, err := a.stats(asset)
	if err != nil {
		return 0, err
	}
	return float64(s.DailyVolume), nil
}
