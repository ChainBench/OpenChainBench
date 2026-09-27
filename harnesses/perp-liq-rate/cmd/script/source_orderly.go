package main

// source_orderly.go — Orderly Network.
//
// Added 2026-09-27 when the cohort was widened. Orderly is the only venue in
// this cohort with a purpose-built public liquidation endpoint that carries
// real history: /v1/public/liquidated_positions takes a time range and pages,
// so a 5-minute poller sees everything. No key, no headers.
//
// Two details of the shape matter:
//
//   - filtering by symbol returns whole liquidated accounts, and an account's
//     positions_by_perp can hold legs on other markets. Only the matching leg
//     counts, or a BTC liquidation lands on the ETH row.
//   - cost_position_transfer is already the USD notional of the leg, signed.
//     Verified against position_qty x transfer_price: 0.0914 x 2688.29 =
//     245.709706, which is the value the field returns.
//
// meta.total saturates at 500, so it is not a count once it reaches that;
// page until a short page instead of trusting it. A 24h window held 43 legs
// venue-wide on 2026-09-27, well under the cap.

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	orderlyBaseURL    = "https://api-evm.orderly.org/v1/public"
	orderlyPageSize   = 100
	orderlyMaxPages   = 10
	orderlyFuturesTTL = 2 * time.Minute
)

// orderlySymbols maps the asset to Orderly's perp symbol.
var orderlySymbols = map[string]string{
	"ETH": "PERP_ETH_USDC",
	"BTC": "PERP_BTC_USDC",
	"SOL": "PERP_SOL_USDC",
}

// Orderly implements Source.
type Orderly struct {
	baseURL string
}

// NewOrderly returns the Orderly source.
func NewOrderly() *Orderly { return &Orderly{baseURL: orderlyBaseURL} }

// HasLiquidationSource reports true — a dedicated public endpoint with history.
func (o *Orderly) HasLiquidationSource() bool { return true }

type orderlyLiqLeg struct {
	Symbol               string    `json:"symbol"`
	PositionQty          flexFloat `json:"position_qty"`
	TransferPrice        flexFloat `json:"transfer_price"`
	CostPositionTransfer flexFloat `json:"cost_position_transfer"` // USD, signed
}

type orderlyLiqRow struct {
	LiquidationID   int64           `json:"liquidation_id"`
	Timestamp       int64           `json:"timestamp"` // unix ms
	PositionsByPerp []orderlyLiqLeg `json:"positions_by_perp"`
}

// FetchLiquidationsSince pages the public liquidation feed for the asset.
func (o *Orderly) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	symbol, ok := orderlySymbols[asset]
	if !ok {
		return nil, fmt.Errorf("orderly: unsupported asset %q", asset)
	}
	endMs := time.Now().UnixMilli()
	var events []LiqEvent
	for page := 1; page <= orderlyMaxPages; page++ {
		u := fmt.Sprintf("%s/liquidated_positions?symbol=%s&start_t=%d&end_t=%d&page=%d&size=%d",
			o.baseURL, url.QueryEscape(symbol), sinceMs, endMs, page, orderlyPageSize)
		var resp struct {
			Data struct {
				Rows []orderlyLiqRow `json:"rows"`
			} `json:"data"`
		}
		if err := httpGetJSON(u, &resp); err != nil {
			return nil, fmt.Errorf("orderly liquidated_positions: %w", err)
		}
		rows := resp.Data.Rows
		for _, r := range rows {
			for _, leg := range r.PositionsByPerp {
				if !strings.EqualFold(leg.Symbol, symbol) {
					continue // another market of the same liquidated account
				}
				usd := float64(leg.CostPositionTransfer)
				if usd < 0 {
					usd = -usd
				}
				if usd <= 0 {
					continue
				}
				events = append(events, LiqEvent{
					Key: "orderly:" + strconv.FormatInt(r.LiquidationID, 10) +
						":" + leg.Symbol,
					NotionalUSD: usd,
					TimestampMs: r.Timestamp,
				})
			}
		}
		if len(rows) < orderlyPageSize {
			break
		}
	}
	return events, nil
}

// orderlyFutures is the part of /futures/{symbol} this harness needs.
type orderlyFutures struct {
	OpenInterest flexFloat `json:"open_interest"` // base units
	MarkPrice    flexFloat `json:"mark_price"`    // USD
	Amount24h    flexFloat `json:"24h_amount"`    // USD notional traded
}

func (o *Orderly) futures(asset string) (orderlyFutures, error) {
	symbol, ok := orderlySymbols[asset]
	if !ok {
		return orderlyFutures{}, fmt.Errorf("orderly: unsupported asset %q", asset)
	}
	var resp struct {
		Data orderlyFutures `json:"data"`
	}
	if err := httpGetJSON(o.baseURL+"/futures/"+url.PathEscape(symbol), &resp); err != nil {
		return orderlyFutures{}, fmt.Errorf("orderly futures: %w", err)
	}
	return resp.Data, nil
}

// FetchOI returns open_interest x mark_price in USD.
func (o *Orderly) FetchOI(asset string) (float64, error) {
	f, err := o.futures(asset)
	if err != nil {
		return 0, err
	}
	if float64(f.MarkPrice) == 0 {
		return 0, fmt.Errorf("orderly: mark_price is zero for %s", asset)
	}
	return float64(f.OpenInterest) * float64(f.MarkPrice), nil
}

// FetchVolume24hUSD returns 24h_amount, the market's 24h notional in USD.
func (o *Orderly) FetchVolume24hUSD(asset string) (float64, error) {
	f, err := o.futures(asset)
	if err != nil {
		return 0, err
	}
	return float64(f.Amount24h), nil
}
