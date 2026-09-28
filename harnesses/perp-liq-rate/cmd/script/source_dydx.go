package main

// source_dydx.go: dYdX v4 (indexer.dydx.trade).
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
	// The first tick backfills a full 24h and dYdX ETH printed 7,754 trades
	// in 24h on 2026-09-27; the old cap of 30 pages read less than half of
	// that after every restart and said nothing. Sized for a day several
	// times busier than that one, since the range is floored at the window.
	dydxMaxPages = 500
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

// HasLiquidationSource reports true: public trade tape exposes LIQUIDATED type.
func (d *Dydx) HasLiquidationSource() bool { return true }

// FetchLiquidationsSince pages the trade feed backwards until sinceMs.
func (d *Dydx) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	ticker, ok := dydxTickers[asset]
	if !ok {
		return nil, fmt.Errorf("dydx: unsupported asset %q", asset)
	}

	var events []LiqEvent
	createdBefore := ""
	oldestReadMs := int64(0)

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
			return events, nil // the tape ran out before the cap did
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
			return events, nil
		}
		// createdBeforeOrAt is inclusive, so the boundary trade repeats on
		// the next page; the SeenSet dedup absorbs that.
		createdBefore = oldestStr
		oldestReadMs = oldestMs
	}
	// Reaching the cap means the oldest part of the window was never read.
	// The rows read are handed over with the edge, so the runner can hold
	// the rank rather than the harness repeating a request that cannot fit.
	return events, &partialWindowError{OldestReadMs: oldestReadMs, Cap: dydxMaxPages * dydxPageSize, What: "dydx trades " + ticker}
}

type dydxMarket struct {
	OpenInterest string `json:"openInterest"`
	OraclePrice  string `json:"oraclePrice"`
	// volume24H is already quote-denominated (USD).
	Volume24H string `json:"volume24H"`
}

// market resolves one ticker from /perpetualMarkets.
func (d *Dydx) market(asset string) (dydxMarket, error) {
	ticker, ok := dydxTickers[asset]
	if !ok {
		return dydxMarket{}, fmt.Errorf("dydx: unsupported asset %q", asset)
	}
	var resp struct {
		// The v4 indexer returns an object keyed by ticker under "markets"
		// (the written spec said "array"; the live API is a map).
		Markets map[string]dydxMarket `json:"markets"`
	}
	if err := httpGetJSON(d.baseURL+"/perpetualMarkets", &resp); err != nil {
		return dydxMarket{}, fmt.Errorf("dydx perpetualMarkets: %w", err)
	}
	m, ok := resp.Markets[ticker]
	if !ok {
		return dydxMarket{}, fmt.Errorf("dydx: market %q not found", ticker)
	}
	return m, nil
}

// FetchVolume24hUSD returns the market's 24h traded notional in USD.
func (d *Dydx) FetchVolume24hUSD(asset string) (float64, error) {
	m, err := d.market(asset)
	if err != nil {
		return 0, err
	}
	v, err := parseF(m.Volume24H)
	if err != nil {
		return 0, fmt.Errorf("dydx volume24H: %w", err)
	}
	return v, nil
}

// FetchOI returns openInterest * oraclePrice for the ticker.
func (d *Dydx) FetchOI(asset string) (float64, error) {
	m, err := d.market(asset)
	if err != nil {
		return 0, err
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
