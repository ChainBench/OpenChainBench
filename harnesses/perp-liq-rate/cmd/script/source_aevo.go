package main

// source_aevo.go — Aevo.
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

// HasLiquidationSource reports false — Aevo has no public liquidation feed.
// liq_rate is not published (N/A, not 0%).
func (a *Aevo) HasLiquidationSource() bool { return false }

// FetchLiquidationsSince returns empty — Aevo has no public liquidation feed.
func (a *Aevo) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	if _, ok := aevoInstruments[asset]; !ok {
		return nil, fmt.Errorf("aevo: unsupported asset %q", asset)
	}
	return nil, nil
}

// FetchOI returns open interest in USD from /statistics.
// VERIFY: response shape — open_interest.total is in contract units (ETH/BTC),
// mark_price is the USD price; OI_USD = total * mark_price.
func (a *Aevo) FetchOI(asset string) (float64, error) {
	instrument, ok := aevoInstruments[asset]
	if !ok {
		return 0, fmt.Errorf("aevo: unsupported asset %q", asset)
	}
	base := strings.TrimSuffix(instrument, "-PERP")
	var resp struct {
		OpenInterest struct {
			Total flexFloat `json:"total"`
		} `json:"open_interest"`
		MarkPrice flexFloat `json:"mark_price"`
	}
	u := fmt.Sprintf("%s/statistics?asset=%s&instrument_type=PERPETUAL", a.baseURL, base)
	if err := httpGetJSON(u, &resp); err != nil {
		return 0, fmt.Errorf("aevo statistics: %w", err)
	}
	total := float64(resp.OpenInterest.Total)
	markPrice := float64(resp.MarkPrice)
	if markPrice == 0 {
		return 0, fmt.Errorf("aevo statistics: mark_price is zero")
	}
	return total * markPrice, nil
}
