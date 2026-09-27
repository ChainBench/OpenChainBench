package main

// source_aster.go — Aster on BNB Chain.
//
// Added 2026-09-27 when the cohort was widened. Aster's own history endpoint
// for forced orders is gone (/fapi/v1/allForceOrders answers "The endpoint
// has been out of maintenance", and /fapi/v1/forceOrders is per-account), and
// its public !forceOrder websocket stream carries no history and drops every
// few minutes, so a 5-minute REST poller cannot use it. Coinalyze does cover
// Aster, as exchange code S, and its hourly liquidation buckets are the same
// shape the Lighter row already reads. Measured over the 24h to 2026-09-27:
// 82.687 ETH and 2.049 BTC, about $224k and $173k.
//
// OI and 24h notional come from Aster's own gateway, the same host the
// cohort harness reads.

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	asterFapiBase   = "https://fapi.asterdex.com/fapi/v1"
	asterTickerTTL  = 2 * time.Minute
	asterOIEndpoint = "/openInterest"
)

// asterSymbols maps the asset to Aster's USDT-margined perp symbol and the
// Coinalyze symbol for the same market.
var asterSymbols = map[string]struct{ native, coinalyze string }{
	"ETH": {"ETHUSDT", "ETHUSDT.S"},
	"BTC": {"BTCUSDT", "BTCUSDT.S"},
	"SOL": {"SOLUSDT", "SOLUSDT.S"},
}

// asterTicker is the part of /ticker/24hr this harness needs. quoteVolume is
// already quote-denominated (USDT), so it is the USD notional.
type asterTicker struct {
	Symbol      string `json:"symbol"`
	LastPrice   string `json:"lastPrice"`
	QuoteVolume string `json:"quoteVolume"`
}

// Aster implements Source.
type Aster struct {
	baseURL   string
	czBaseURL string
	czAPIKey  string
	hlInfoURL string // HL candleSnapshot, overridable in tests

	mu       sync.Mutex
	tickers  map[string]asterTicker
	tickerAt time.Time
}

// NewAster returns the Aster source.
func NewAster() *Aster {
	return &Aster{
		baseURL:   asterFapiBase,
		czBaseURL: czBaseURLDefault,
		czAPIKey:  os.Getenv("COINALYZE_API_KEY"),
	}
}

// HasLiquidationSource reports true — Coinalyze publishes hourly buckets for
// Aster's markets.
func (a *Aster) HasLiquidationSource() bool { return true }

// ticker reads (and caches) the bulk /ticker/24hr snapshot.
func (a *Aster) ticker(symbol string) (asterTicker, error) {
	a.mu.Lock()
	if a.tickers != nil && time.Since(a.tickerAt) < asterTickerTTL {
		t, ok := a.tickers[symbol]
		a.mu.Unlock()
		if !ok {
			return asterTicker{}, fmt.Errorf("aster: symbol %q not in ticker snapshot", symbol)
		}
		return t, nil
	}
	a.mu.Unlock()

	var rows []asterTicker
	if err := httpGetJSON(a.baseURL+"/ticker/24hr", &rows); err != nil {
		return asterTicker{}, fmt.Errorf("aster ticker/24hr: %w", err)
	}
	if len(rows) == 0 {
		return asterTicker{}, fmt.Errorf("aster ticker/24hr: empty snapshot")
	}
	m := make(map[string]asterTicker, len(rows))
	for _, r := range rows {
		m[strings.ToUpper(r.Symbol)] = r
	}
	a.mu.Lock()
	a.tickers, a.tickerAt = m, time.Now()
	a.mu.Unlock()

	t, ok := m[symbol]
	if !ok {
		return asterTicker{}, fmt.Errorf("aster: symbol %q not in ticker snapshot", symbol)
	}
	return t, nil
}

// FetchLiquidationsSince returns Coinalyze hourly buckets for the asset,
// marked for restatement so an hour still filling is re-read rather than
// frozen at its first reading.
func (a *Aster) FetchLiquidationsSince(asset string, _ int64) ([]LiqEvent, error) {
	sym, ok := asterSymbols[asset]
	if !ok {
		return nil, fmt.Errorf("aster: unsupported asset %q", asset)
	}
	if a.czAPIKey == "" {
		return nil, nil
	}
	t, err := a.ticker(sym.native)
	if err != nil {
		return nil, err
	}
	fallbackPx, err := parseF(t.LastPrice)
	if err != nil {
		return nil, fmt.Errorf("aster lastPrice: %w", err)
	}

	now := time.Now()
	from := now.Add(-25 * time.Hour).Unix()
	to := now.Unix()
	cz := &czClient{apiKey: a.czAPIKey, baseURL: a.czBaseURL}
	buckets, err := cz.fetchLiqBuckets(sym.coinalyze, from, to)
	if err != nil {
		return nil, fmt.Errorf("aster coinalyze liquidations: %w", err)
	}
	// Coinalyze reports Aster's buckets in base-asset units
	// (oi_lq_vol_denominated_in = BASE_ASSET), so each hour is converted at
	// that hour's close, with the current last price as the fallback.
	priceMap, _ := fetchHourlyCloses(asset, from*1000, to*1000, a.hlInfoURL)
	return bucketsToEvents("czaster", asset, buckets, priceMap, fallbackPx), nil
}

// FetchOI returns open interest in USD. /openInterest is one-sided base-asset
// units with no contract multiplier.
func (a *Aster) FetchOI(asset string) (float64, error) {
	sym, ok := asterSymbols[asset]
	if !ok {
		return 0, fmt.Errorf("aster: unsupported asset %q", asset)
	}
	var resp struct {
		OpenInterest flexFloat `json:"openInterest"`
	}
	u := a.baseURL + asterOIEndpoint + "?symbol=" + url.QueryEscape(sym.native)
	if err := httpGetJSON(u, &resp); err != nil {
		return 0, fmt.Errorf("aster openInterest: %w", err)
	}
	t, err := a.ticker(sym.native)
	if err != nil {
		return 0, err
	}
	px, err := parseF(t.LastPrice)
	if err != nil {
		return 0, fmt.Errorf("aster lastPrice: %w", err)
	}
	if px == 0 {
		return 0, fmt.Errorf("aster: lastPrice is zero for %s", sym.native)
	}
	return float64(resp.OpenInterest) * px, nil
}

// FetchVolume24hUSD returns quoteVolume, the symbol's 24h notional in USDT.
func (a *Aster) FetchVolume24hUSD(asset string) (float64, error) {
	sym, ok := asterSymbols[asset]
	if !ok {
		return 0, fmt.Errorf("aster: unsupported asset %q", asset)
	}
	t, err := a.ticker(sym.native)
	if err != nil {
		return 0, err
	}
	v, err := parseF(t.QuoteVolume)
	if err != nil {
		return 0, fmt.Errorf("aster quoteVolume: %w", err)
	}
	return v, nil
}
