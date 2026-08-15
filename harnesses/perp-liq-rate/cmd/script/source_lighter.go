package main

// source_lighter.go — Lighter (mainnet.zklighter.elliot.ai).
//
// Liquidations: Lighter /api/v1/trades requires auth (HTTP 400). Data comes
// from Coinalyze /v1/liquidation-history (symbols 0.T=ETH, 1.T=BTC), hourly
// buckets in base asset units; multiplied by current mark_price from
// orderBookDetails. Requires env COINALYZE_API_KEY; returns empty without it.
// OI: GET /api/v1/orderBookDetails?filter=perp; open_interest (base units) ×
// mark_price (USD). Market IDs resolved dynamically by symbol prefix match.
// 404/501 marks the venue unavailable; after 3 consecutive failures the source
// logs once and suppresses further error increments until recovery.

import (
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	lighterBaseURL          = "https://mainnet.zklighter.elliot.ai"
	lighterMarketTTL        = 2 * time.Minute
	lighterFailLogThreshold = 3
	czBaseURLDefault        = "https://api.coinalyze.net/v1"
)

// czLighterSymbols maps asset → Coinalyze symbol for Lighter perps.
var czLighterSymbols = map[string]string{
	"ETH": "0.T",
	"BTC": "1.T",
}

type lighterMarketDetail struct {
	Symbol       string    `json:"symbol"`
	MarketID     int64     `json:"market_id"`
	OpenInterest float64   `json:"open_interest"` // base units (e.g. ETH)
	MarkPrice    flexFloat `json:"mark_price"`     // USD per base unit
}

// Lighter implements Source with dynamic market ID resolution and
// consecutive-unavailability tracking.
type Lighter struct {
	baseURL   string // defaults to lighterBaseURL
	czBaseURL string // Coinalyze API base, defaults to czBaseURLDefault
	czAPIKey  string // from env COINALYZE_API_KEY

	mu          sync.Mutex
	markets     []lighterMarketDetail
	marketsAt   time.Time
	consecUnavl int
}

// NewLighter returns the Lighter source.
func NewLighter() *Lighter {
	return &Lighter{
		baseURL:   lighterBaseURL,
		czBaseURL: czBaseURLDefault,
		czAPIKey:  os.Getenv("COINALYZE_API_KEY"),
	}
}

// fetchMarkets fetches and caches the /api/v1/orderBookDetails response.
// On cache miss two concurrent goroutines may both fetch; the second write
// simply overwrites the first with slightly newer data, which is harmless.
func (l *Lighter) fetchMarkets() ([]lighterMarketDetail, error) {
	l.mu.Lock()
	if l.markets != nil && time.Since(l.marketsAt) < lighterMarketTTL {
		m := l.markets
		l.mu.Unlock()
		return m, nil
	}
	l.mu.Unlock()

	var resp struct {
		OrderBookDetails []lighterMarketDetail `json:"order_book_details"`
	}
	if err := httpGetJSON(l.baseURL+"/api/v1/orderBookDetails?filter=perp", &resp); err != nil {
		return nil, fmt.Errorf("lighter orderBookDetails: %w", err)
	}
	if len(resp.OrderBookDetails) == 0 {
		return nil, fmt.Errorf("lighter: empty orderBookDetails")
	}
	l.mu.Lock()
	l.markets = resp.OrderBookDetails
	l.marketsAt = time.Now()
	l.mu.Unlock()
	return resp.OrderBookDetails, nil
}

// lighterSymbolMatchesAsset reports whether a market symbol (e.g. "ETH-USD")
// corresponds to the requested asset (e.g. "ETH").
func lighterSymbolMatchesAsset(symbol, asset string) bool {
	sym := strings.ToUpper(strings.TrimSpace(symbol))
	a := strings.ToUpper(asset)
	return sym == a || strings.HasPrefix(sym, a+"-") || strings.HasPrefix(sym, a+"/")
}

func (l *Lighter) findMarket(asset string) (lighterMarketDetail, error) {
	markets, err := l.fetchMarkets()
	if err != nil {
		return lighterMarketDetail{}, err
	}
	for _, m := range markets {
		if lighterSymbolMatchesAsset(m.Symbol, asset) {
			return m, nil
		}
	}
	return lighterMarketDetail{}, fmt.Errorf("lighter: no market found for asset %q", asset)
}

// FetchLiquidationsSince returns hourly liquidation buckets from Coinalyze,
// HasLiquidationSource reports true — Coinalyze provides hourly liq buckets.
func (l *Lighter) HasLiquidationSource() bool { return true }

// converted to USD using the current mark_price from orderBookDetails.
// Returns empty if COINALYZE_API_KEY is not set.
func (l *Lighter) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	market, err := l.findMarket(asset)
	if err != nil {
		var se *httpStatusError
		if errors.As(err, &se) && (se.Code == 404 || se.Code == 501) {
			return nil, l.markUnavailable(se.Code)
		}
		return nil, err
	}

	if l.czAPIKey == "" {
		return nil, nil
	}
	czSym, ok := czLighterSymbols[asset]
	if !ok {
		return nil, nil
	}

	markPx := float64(market.MarkPrice)
	if markPx == 0 {
		return nil, nil
	}

	from := sinceMs / 1000
	to := time.Now().Unix()
	u := fmt.Sprintf("%s/liquidation-history?symbols=%s&interval=1hour&from=%d&to=%d&api_key=%s",
		l.czBaseURL, url.QueryEscape(czSym), from, to, l.czAPIKey)

	var resp []struct {
		Symbol  string `json:"symbol"`
		History []struct {
			T int64   `json:"t"` // unix seconds (bucket start)
			L float64 `json:"l"` // long liqs (base asset)
			S float64 `json:"s"` // short liqs (base asset)
		} `json:"history"`
	}
	if err := httpGetJSON(u, &resp); err != nil {
		return nil, fmt.Errorf("lighter coinalyze liquidations: %w", err)
	}

	var events []LiqEvent
	for _, r := range resp {
		for _, h := range r.History {
			tsMs := h.T * 1000
			if tsMs < sinceMs {
				continue
			}
			total := (h.L + h.S) * markPx
			if total == 0 {
				continue
			}
			events = append(events, LiqEvent{
				Key:         fmt.Sprintf("czlighter:%s:%d", asset, h.T),
				NotionalUSD: total,
				TimestampMs: tsMs,
			})
		}
	}
	return events, nil
}

// markUnavailable tracks consecutive 404/501 responses; at the threshold it
// logs once, and beyond it asks the runner to suppress counters and logs.
func (l *Lighter) markUnavailable(status int) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.consecUnavl++
	if l.consecUnavl == lighterFailLogThreshold {
		log.Printf("[lighter] endpoint unavailable %d consecutive times (http %d); suppressing further unavailability error metrics and logs until recovery",
			l.consecUnavl, status)
	}
	return &unavailableError{status: status, suppressed: l.consecUnavl > lighterFailLogThreshold}
}

func (l *Lighter) resetUnavailable() {
	l.mu.Lock()
	if l.consecUnavl > 0 {
		log.Printf("[lighter] endpoint recovered after %d consecutive unavailability(ies)", l.consecUnavl)
	}
	l.consecUnavl = 0
	l.mu.Unlock()
}

// FetchOI returns open_interest × mark_price from the orderBookDetails cache.
func (l *Lighter) FetchOI(asset string) (float64, error) {
	market, err := l.findMarket(asset)
	if err != nil {
		return 0, err
	}
	markPx := float64(market.MarkPrice)
	if markPx == 0 {
		return 0, fmt.Errorf("lighter: mark_price is zero for %s", asset)
	}
	return market.OpenInterest * markPx, nil
}
