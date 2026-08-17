package main

// source_paradex.go — Paradex.
//
// Liquidations: GET /v1/trades?market=X&start_at=<ms>&end_at=<now_ms>
// &page_size=100, following the "next" cursor; keep rows whose trade_type
// equals "LIQUIDATION". VERIFY: exact trade_type value — the field was added
// in Paradex v1.38; the assumed value is "LIQUIDATION". Notional = size×price.
// OI: GET /v1/markets/summary?market=X → open_interest. VERIFY: unit
// (base-asset vs USD) by comparing BTC vs ETH order of magnitude at runtime.

import (
	"fmt"
	"net/url"
	"time"
)

const (
	paradexBaseURL  = "https://api.prod.paradex.trade/v1"
	paradexPageSize = 100
	paradexMaxPages = 20
)

var paradexMarkets = map[string]string{
	"ETH": "ETH-USD-PERP",
	"BTC": "BTC-USD-PERP",
}

// Paradex implements Source. It is stateless and shared across assets.
type Paradex struct {
	baseURL string // defaults to paradexBaseURL
}

// NewParadex returns the Paradex source.
func NewParadex() *Paradex { return &Paradex{baseURL: paradexBaseURL} }

type paradexTrade struct {
	ID        string `json:"id"`
	Size      string `json:"size"`
	Price     string `json:"price"`
	CreatedAt int64  `json:"created_at"` // unix ms
	TradeType string `json:"trade_type"` // "FILL", "LIQUIDATION", etc.
}

type paradexTradesResp struct {
	Results []paradexTrade `json:"results"`
	Next    *string        `json:"next"`
}

// HasLiquidationSource reports true — public trade tape exposes LIQUIDATION trade_type.
func (p *Paradex) HasLiquidationSource() bool { return true }

// FetchLiquidationsSince pages the public trade tape and keeps LIQUIDATION rows.
func (p *Paradex) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	market, ok := paradexMarkets[asset]
	if !ok {
		return nil, fmt.Errorf("paradex: unsupported asset %q", asset)
	}

	var events []LiqEvent
	cursor := ""
	endMs := time.Now().UnixMilli()

	for page := 0; page < paradexMaxPages; page++ {
		u := fmt.Sprintf("%s/trades?market=%s&start_at=%d&end_at=%d&page_size=%d",
			p.baseURL, url.QueryEscape(market), sinceMs, endMs, paradexPageSize)
		if cursor != "" {
			u += "&cursor=" + url.QueryEscape(cursor)
		}
		var resp paradexTradesResp
		if err := httpGetJSON(u, &resp); err != nil {
			return nil, fmt.Errorf("paradex trades: %w", err)
		}
		for _, t := range resp.Results {
			if t.TradeType != "LIQUIDATION" {
				continue
			}
			if t.CreatedAt < sinceMs {
				continue
			}
			size, err := parseF(t.Size)
			if err != nil {
				return nil, fmt.Errorf("paradex size: %w", err)
			}
			price, err := parseF(t.Price)
			if err != nil {
				return nil, fmt.Errorf("paradex price: %w", err)
			}
			key := t.ID
			if key == "" {
				key = fmt.Sprintf("%s:%d:%s:%s", market, t.CreatedAt, t.Size, t.Price)
			}
			events = append(events, LiqEvent{
				Key:         "paradex:" + key,
				NotionalUSD: size * price,
				TimestampMs: t.CreatedAt,
			})
		}
		if resp.Next == nil || *resp.Next == "" || *resp.Next == "null" || len(resp.Results) == 0 {
			break
		}
		cursor = *resp.Next
	}
	return events, nil
}

// FetchOI returns open interest in USD from the market summary.
// open_interest is in base-asset units (ETH, BTC); multiply by mark_price.
func (p *Paradex) FetchOI(asset string) (float64, error) {
	market, ok := paradexMarkets[asset]
	if !ok {
		return 0, fmt.Errorf("paradex: unsupported asset %q", asset)
	}
	var resp struct {
		Results []struct {
			OpenInterest flexFloat `json:"open_interest"` // base units
			MarkPrice    flexFloat `json:"mark_price"`    // USD per base unit
		} `json:"results"`
	}
	u := fmt.Sprintf("%s/markets/summary?market=%s", p.baseURL, url.QueryEscape(market))
	if err := httpGetJSON(u, &resp); err != nil {
		return 0, fmt.Errorf("paradex markets/summary: %w", err)
	}
	if len(resp.Results) == 0 {
		return 0, fmt.Errorf("paradex markets/summary: empty results for %s", market)
	}
	r := resp.Results[0]
	markPx := float64(r.MarkPrice)
	if markPx == 0 {
		return 0, fmt.Errorf("paradex markets/summary: mark_price is zero for %s", market)
	}
	return float64(r.OpenInterest) * markPx, nil
}
