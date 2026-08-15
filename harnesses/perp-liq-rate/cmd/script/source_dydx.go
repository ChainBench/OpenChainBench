package main

// source_dydx.go — dYdX v4 (indexer.dydx.trade).
//
// Liquidations: GET /v4/trades/perpetualMarket/{ticker}?limit=100, keep
// type == "LIQUIDATED", paginate backwards with createdBeforeOrAt until the
// page's oldest trade predates sinceMs.
// OI: GET /v4/perpetualMarkets; openInterest (base units) * oraclePrice.

import (
	"fmt"
	"net/url"
	"time"
)

const (
	dydxBaseURL  = "https://indexer.dydx.trade/v4"
	dydxPageSize = 100
	dydxMaxPages = 30 // safety cap: 3000 trades per tick per market
)

var dydxTickers = map[string]string{
	"ETH": "ETH-USD",
	"BTC": "BTC-USD",
	"SOL": "SOL-USD",
}

// Dydx implements Source. It is stateless and shared across assets.
type Dydx struct {
	baseURL string // defaults to dydxBaseURL
}

// NewDydx returns the dYdX source.
func NewDydx() *Dydx { return &Dydx{baseURL: dydxBaseURL} }

type dydxTrade struct {
	ID        string `json:"id"`
	Size      string `json:"size"`
	Price     string `json:"price"`
	Type      string `json:"type"`
	CreatedAt string `json:"createdAt"` // ISO8601
}

type dydxTradesResp struct {
	Trades []dydxTrade `json:"trades"`
}

// HasLiquidationSource reports true — public trade tape exposes LIQUIDATED type.
func (d *Dydx) HasLiquidationSource() bool { return true }

// FetchLiquidationsSince pages the trade feed backwards until sinceMs.
func (d *Dydx) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	ticker, ok := dydxTickers[asset]
	if !ok {
		return nil, fmt.Errorf("dydx: unsupported asset %q", asset)
	}

	var events []LiqEvent
	createdBefore := ""

	for page := 0; page < dydxMaxPages; page++ {
		u := fmt.Sprintf("%s/trades/perpetualMarket/%s?limit=%d", d.baseURL, url.PathEscape(ticker), dydxPageSize)
		if createdBefore != "" {
			u += "&createdBeforeOrAt=" + url.QueryEscape(createdBefore)
		}
		var resp dydxTradesResp
		if err := httpGetJSON(u, &resp); err != nil {
			return nil, fmt.Errorf("dydx trades: %w", err)
		}
		if len(resp.Trades) == 0 {
			break
		}

		oldestMs := int64(1<<62 - 1)
		oldestStr := ""
		for _, t := range resp.Trades {
			ts, err := time.Parse(time.RFC3339Nano, t.CreatedAt)
			if err != nil {
				return nil, fmt.Errorf("dydx createdAt %q: %w", t.CreatedAt, err)
			}
			ms := ts.UnixMilli()
			if ms < oldestMs {
				oldestMs = ms
				oldestStr = t.CreatedAt
			}
			if t.Type != "LIQUIDATED" || ms < sinceMs {
				continue
			}
			sz, err := parseF(t.Size)
			if err != nil {
				return nil, fmt.Errorf("dydx size: %w", err)
			}
			px, err := parseF(t.Price)
			if err != nil {
				return nil, fmt.Errorf("dydx price: %w", err)
			}
			events = append(events, LiqEvent{
				Key:         t.ID,
				NotionalUSD: sz * px,
				TimestampMs: ms,
			})
		}

		// Stop once the page reaches past our since bound or is short.
		if oldestMs < sinceMs || len(resp.Trades) < dydxPageSize {
			break
		}
		// createdBeforeOrAt is inclusive, so the boundary trade repeats on
		// the next page; the SeenSet dedup absorbs that.
		createdBefore = oldestStr
	}
	return events, nil
}

type dydxMarket struct {
	OpenInterest string `json:"openInterest"`
	OraclePrice  string `json:"oraclePrice"`
}

// FetchOI returns openInterest * oraclePrice for the ticker.
func (d *Dydx) FetchOI(asset string) (float64, error) {
	ticker, ok := dydxTickers[asset]
	if !ok {
		return 0, fmt.Errorf("dydx: unsupported asset %q", asset)
	}
	var resp struct {
		// VERIFY: the v4 indexer returns an object keyed by ticker under
		// "markets" (the written spec said "array"; the live API is a map).
		Markets map[string]dydxMarket `json:"markets"`
	}
	if err := httpGetJSON(d.baseURL+"/perpetualMarkets", &resp); err != nil {
		return 0, fmt.Errorf("dydx perpetualMarkets: %w", err)
	}
	m, ok := resp.Markets[ticker]
	if !ok {
		return 0, fmt.Errorf("dydx: market %q not found", ticker)
	}
	oi, err := parseF(m.OpenInterest)
	if err != nil {
		return 0, fmt.Errorf("dydx openInterest: %w", err)
	}
	px, err := parseF(m.OraclePrice)
	if err != nil {
		return 0, fmt.Errorf("dydx oraclePrice: %w", err)
	}
	return oi * px, nil
}
