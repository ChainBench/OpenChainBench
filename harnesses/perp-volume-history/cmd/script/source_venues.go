package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

// ---------------------------------------------------------------------
// Orderly (dimension-adapters/dexs/orderly-perps-new.ts)
// ---------------------------------------------------------------------

// orderlySource reads api-evm.orderly.org/md/volume/daily_stats: one row
// per UTC day since 2023-10-26 with the day's perp volume in USD.
type orderlySource struct{ meta venueMeta }

func (s *orderlySource) Slug() string        { return s.meta.slug }
func (s *orderlySource) DisplayName() string { return s.meta.name }
func (s *orderlySource) Name() string        { return "orderly-daily-stats" }
func (s *orderlySource) Note() string        { return "Orderly Network md/volume/daily_stats, all chains" }
func (s *orderlySource) Start() time.Time    { return s.meta.start }

func (s *orderlySource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	var rows []struct {
		Volume string `json:"volume"`
		Date   string `json:"date"`
	}
	if err := getJSON(ctx, "https://api-evm.orderly.org/md/volume/daily_stats", &rows); err != nil {
		return nil, err
	}
	out := map[time.Time]float64{}
	for _, r := range rows {
		if len(r.Date) < 10 {
			continue
		}
		d, err := parseDay(r.Date[:10])
		if err != nil || !inRange(d, from, to) {
			continue
		}
		v, err := strconv.ParseFloat(r.Volume, 64)
		if err != nil {
			continue
		}
		out[d] = v
	}
	return out, nil
}

// ---------------------------------------------------------------------
// Paradex (dimension-adapters/dexs/paradex/index.ts)
// ---------------------------------------------------------------------

// paradexSource reads the public Metabase card Paradex publishes (the
// one the DeFiLlama adapter reads): TRADE_DATE, PERP_VOLUME, ... one row
// per UTC day. Metabase answers 202 with the body on cold cache; the
// JSON helper treats any 2xx as success.
type paradexSource struct{ meta venueMeta }

const paradexDailyURL = "https://tradeparadigm.metabaseapp.com/api/public/dashboard/e4d7b84d-f95f-48eb-b7a6-141b3dcef4e2/dashcard/20065/card/21187?parameters=%5B%5D"

func (s *paradexSource) Slug() string        { return s.meta.slug }
func (s *paradexSource) DisplayName() string { return s.meta.name }
func (s *paradexSource) Name() string        { return "paradex-metabase" }
func (s *paradexSource) Note() string {
	return "Paradex public Metabase daily card, PERP_VOLUME column (perps only, options and spot excluded)"
}
func (s *paradexSource) Start() time.Time { return s.meta.start }

func (s *paradexSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	var resp struct {
		Data struct {
			Cols []struct {
				Name string `json:"name"`
			} `json:"cols"`
			Rows [][]any `json:"rows"`
		} `json:"data"`
	}
	if err := getJSON(ctx, paradexDailyURL, &resp); err != nil {
		return nil, err
	}
	dateIdx, volIdx := -1, -1
	for i, c := range resp.Data.Cols {
		switch c.Name {
		case "TRADE_DATE":
			dateIdx = i
		case "PERP_VOLUME":
			volIdx = i
		}
	}
	if dateIdx < 0 || volIdx < 0 {
		return nil, fmt.Errorf("card columns changed: %v", resp.Data.Cols)
	}
	out := map[time.Time]float64{}
	for _, r := range resp.Data.Rows {
		if len(r) <= dateIdx || len(r) <= volIdx {
			continue
		}
		ds, _ := r[dateIdx].(string)
		if len(ds) < 10 {
			continue
		}
		d, err := parseDay(ds[:10])
		if err != nil || !inRange(d, from, to) {
			continue
		}
		v, ok := toFloat(r[volIdx])
		if !ok {
			continue
		}
		out[d] = v
	}
	return out, nil
}

// ---------------------------------------------------------------------
// Extended (dimension-adapters/dexs/extended/index.ts)
// ---------------------------------------------------------------------

// extendedSource reads /api/v1/exchange/stats/trading?fromDate=D&toDate=D
// on the Starknet deployment (and the Ethereum one until it went dead
// on 2025-12-29). Rows are per market and count both sides of each
// trade, hence the /2, as in the adapter.
//
// The Ethereum host answers 504 since the deployment shut down: a host
// that fails three days in a row is skipped for the rest of the sweep,
// so a dead deployment costs seconds, not a retry ladder per day.
type extendedSource struct{ meta venueMeta }

var extendedEthDeadFrom = day("2025-12-29")

func (s *extendedSource) Slug() string        { return s.meta.slug }
func (s *extendedSource) DisplayName() string { return s.meta.name }
func (s *extendedSource) Name() string        { return "extended-stats" }
func (s *extendedSource) Note() string {
	return "Extended exchange/stats/trading per day, Starknet (Ethereum deployment until 2025-12-29), both sides halved"
}
func (s *extendedSource) Start() time.Time { return s.meta.start }

func (s *extendedSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	out := map[time.Time]float64{}
	var firstErr error
	consecutive := map[string]int{}
	err := eachDay(ctx, from, to, func(d time.Time) error {
		hosts := []string{"https://api.starknet.extended.exchange"}
		if d.Before(extendedEthDeadFrom) {
			hosts = append(hosts, "https://api.extended.exchange")
		}
		var total float64
		got := false
		for _, h := range hosts {
			if consecutive[h] >= 3 {
				continue
			}
			var resp struct {
				Data []struct {
					TradingVolume string `json:"tradingVolume"`
				} `json:"data"`
			}
			u := fmt.Sprintf("%s/api/v1/exchange/stats/trading?fromDate=%s&toDate=%s", h, fmtDay(d), fmtDay(d))
			if err := getJSON(ctx, u, &resp); err != nil {
				if firstErr == nil {
					firstErr = err
				}
				consecutive[h]++
				if consecutive[h] == 3 {
					fmt.Printf("[extended] %s failed 3 days in a row, skipped for this sweep: %v\n", h, err)
				}
				continue
			}
			consecutive[h] = 0
			got = true
			for _, r := range resp.Data {
				v, _ := strconv.ParseFloat(r.TradingVolume, 64)
				total += v
			}
		}
		if got {
			out[d] = total / 2
		}
		return nil
	})
	if err != nil {
		return out, err
	}
	if len(out) == 0 && firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}

// ---------------------------------------------------------------------
// Aevo (dimension-adapters/dexs/aevo/index.ts)
// ---------------------------------------------------------------------

// aevoSource reads /statistics?instrument_type=PERPETUAL&end_time=<ns>
// where end_time is the start of the next UTC day in nanoseconds; the
// response's daily_volume is the 24h ending there.
type aevoSource struct{ meta venueMeta }

func (s *aevoSource) Slug() string        { return s.meta.slug }
func (s *aevoSource) DisplayName() string { return s.meta.name }
func (s *aevoSource) Name() string        { return "aevo-statistics" }
func (s *aevoSource) Note() string        { return "Aevo /statistics PERPETUAL daily_volume per UTC day" }
func (s *aevoSource) Start() time.Time    { return s.meta.start }

func (s *aevoSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	out := map[time.Time]float64{}
	var firstErr error
	err := eachDay(ctx, from, to, func(d time.Time) error {
		endNs := d.AddDate(0, 0, 1).Unix() * 1_000_000_000
		var resp struct {
			DailyVolume string `json:"daily_volume"`
		}
		u := fmt.Sprintf("https://api.aevo.xyz/statistics?instrument_type=PERPETUAL&end_time=%d", endNs)
		if err := getJSON(ctx, u, &resp); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			return nil
		}
		v, err := strconv.ParseFloat(resp.DailyVolume, 64)
		if err != nil {
			return nil
		}
		out[d] = v
		return nil
	})
	if err != nil {
		return out, err
	}
	if len(out) == 0 && firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}

// ---------------------------------------------------------------------
// dYdX v4 (dimension-adapters/dexs/dydx-v4)
// ---------------------------------------------------------------------

// dydxSource sums 1DAY candles (usdVolume) across every perpetual market
// on the public indexer. DeFiLlama's adapter reads the live volume24H
// at run time; the candles are the same fills bucketed on UTC days,
// which is what a backfill needs. Candles are paged 100 per call from
// the most recent, so a 400-day backfill is four pages per market.
//
// The indexer rate-limits per IP and, once tripped, answers 429 for a
// while: the throttle stays at one request a second and the sweep gives
// up after a run of rate-limited calls rather than retrying every
// market through the backoff ladder (that took an hour on 2026-09-14).
type dydxSource struct{ meta venueMeta }

func (s *dydxSource) Slug() string        { return s.meta.slug }
func (s *dydxSource) DisplayName() string { return s.meta.name }
func (s *dydxSource) Name() string        { return "dydx-indexer-candles" }
func (s *dydxSource) Note() string {
	return "dYdX v4 indexer 1DAY candles usdVolume summed over all perpetual markets"
}
func (s *dydxSource) Start() time.Time { return s.meta.start }

func (s *dydxSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	var markets struct {
		Markets map[string]struct {
			Status string `json:"status"`
		} `json:"markets"`
	}
	if err := getJSON(ctx, "https://indexer.dydx.trade/v4/perpetualMarkets?limit=1000", &markets); err != nil {
		return nil, err
	}
	out := map[time.Time]float64{}
	th := newThrottle(60)
	failed := 0
	limited := 0
	for ticker := range markets.Markets {
		toISO := to.AddDate(0, 0, 1).Format(time.RFC3339)
		for page := 0; page < 8; page++ {
			if limited >= 6 {
				return nil, fmt.Errorf("indexer rate limited, giving up this sweep (%d markets done)", len(markets.Markets)-failed)
			}
			if err := th.wait(ctx); err != nil {
				return out, err
			}
			var resp struct {
				Candles []struct {
					StartedAt string `json:"startedAt"`
					UsdVolume string `json:"usdVolume"`
				} `json:"candles"`
			}
			u := fmt.Sprintf("https://indexer.dydx.trade/v4/candles/perpetualMarkets/%s?resolution=1DAY&limit=100&toISO=%s",
				url.PathEscape(ticker), url.QueryEscape(toISO))
			if err := getJSON(ctx, u, &resp); err != nil {
				failed++
				if errors.Is(err, ErrRateLimited) {
					limited++
				}
				break
			}
			limited = 0
			if len(resp.Candles) == 0 {
				break
			}
			var oldest time.Time
			for _, c := range resp.Candles {
				t, err := time.Parse(time.RFC3339Nano, c.StartedAt)
				if err != nil {
					continue
				}
				d := utcDay(t)
				oldest = d
				if inRange(d, from, to) {
					v, _ := strconv.ParseFloat(c.UsdVolume, 64)
					out[d] += v
				}
			}
			if oldest.IsZero() || !oldest.After(from) || len(resp.Candles) < 100 {
				break
			}
			toISO = oldest.Format(time.RFC3339)
		}
	}
	if failed > len(markets.Markets)/2 {
		return nil, fmt.Errorf("%d of %d markets failed", failed, len(markets.Markets))
	}
	return out, nil
}

// ---------------------------------------------------------------------
// Lighter (dimension-adapters/dexs/lighterv2 + dexs/lighter-rh)
// ---------------------------------------------------------------------

// lighterSource sums 1d candles (V, quote volume in USD) across every
// perp market (market_id < 2048, the adapters' filter that drops spot)
// on both deployments: zkLighter mainnet and the Robinhood chain one
// (api.rh.lighter.xyz, live since 2026-06-26). DeFiLlama's Lighter
// parent adds the two the same way (Lighter Perps + Lighter RH);
// mainnet alone read 23% under its page on 2026-09-13.
//
// count_back returns the latest N candles regardless of end_timestamp
// on mainnet, so N covers the window plus the running day and the
// range filter drops the rest. The RH API rejects end == start.
type lighterSource struct{ meta venueMeta }

var lighterAPIs = []struct{ name, api string }{
	{"mainnet", "https://mainnet.zklighter.elliot.ai/api/v1"},
	{"robinhood", "https://api.rh.lighter.xyz/api/v1"},
}

func (s *lighterSource) Slug() string        { return s.meta.slug }
func (s *lighterSource) DisplayName() string { return s.meta.name }
func (s *lighterSource) Name() string        { return "lighter-candles" }
func (s *lighterSource) Note() string {
	return "Lighter 1d candles quote volume summed over perp markets (market_id < 2048), zkLighter mainnet + Robinhood chain deployment"
}
func (s *lighterSource) Start() time.Time { return s.meta.start }

func (s *lighterSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	out := map[time.Time]float64{}
	th := newThrottle(240)
	days := int(to.Sub(from).Hours()/24) + 2
	gotMainnet := false
	for _, dep := range lighterAPIs {
		var books struct {
			OrderBooks []struct {
				MarketID int `json:"market_id"`
			} `json:"order_books"`
		}
		if err := getJSON(ctx, dep.api+"/orderBooks?market_id=255", &books); err != nil {
			if dep.name == "mainnet" {
				return nil, fmt.Errorf("mainnet orderBooks: %w", err)
			}
			fmt.Printf("[lighter][%s] skipped: %v\n", dep.name, err)
			continue
		}
		failed, total := 0, 0
		for _, b := range books.OrderBooks {
			if b.MarketID >= 2048 {
				continue
			}
			total++
			if err := th.wait(ctx); err != nil {
				return out, err
			}
			var resp struct {
				Candles []struct {
					T int64   `json:"t"`
					V float64 `json:"V"`
				} `json:"c"`
			}
			u := fmt.Sprintf("%s/candles?market_id=%d&resolution=1d&start_timestamp=%d&end_timestamp=%d&count_back=%d",
				dep.api, b.MarketID, from.Unix(), to.AddDate(0, 0, 1).Unix(), days)
			if err := getJSON(ctx, u, &resp); err != nil {
				failed++
				continue
			}
			for _, c := range resp.Candles {
				d := utcDay(time.UnixMilli(c.T))
				if inRange(d, from, to) {
					out[d] += c.V
				}
			}
		}
		if total > 0 && failed > total/2 {
			if dep.name == "mainnet" {
				return nil, fmt.Errorf("%d of %d mainnet markets failed", failed, total)
			}
			fmt.Printf("[lighter][%s] %d of %d markets failed\n", dep.name, failed, total)
			continue
		}
		if dep.name == "mainnet" {
			gotMainnet = true
		}
	}
	if !gotMainnet {
		return nil, fmt.Errorf("mainnet returned nothing")
	}
	return out, nil
}

// ---------------------------------------------------------------------
// Aster (Binance-compatible fapi)
// ---------------------------------------------------------------------

// asterSource sums 1d klines quoteVolume (USDT notional) across every
// TRADING perpetual symbol on fapi.asterdex.com. Aster's DeFiLlama
// derivatives adapter reads the same fapi tickers; klines are the
// backfillable form of the same series. ~570 symbols, one call each
// for up to 1500 days.
type asterSource struct{ meta venueMeta }

func (s *asterSource) Slug() string        { return s.meta.slug }
func (s *asterSource) DisplayName() string { return s.meta.name }
func (s *asterSource) Name() string        { return "aster-fapi-klines" }
func (s *asterSource) Note() string {
	return "Aster fapi 1d klines quoteVolume summed over TRADING perpetual symbols"
}
func (s *asterSource) Start() time.Time { return s.meta.start }

func (s *asterSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	var info struct {
		Symbols []struct {
			Symbol       string `json:"symbol"`
			ContractType string `json:"contractType"`
			Status       string `json:"status"`
		} `json:"symbols"`
	}
	if err := getJSON(ctx, "https://fapi.asterdex.com/fapi/v1/exchangeInfo", &info); err != nil {
		return nil, err
	}
	out := map[time.Time]float64{}
	th := newThrottle(240)
	failed, total := 0, 0
	days := int(to.Sub(from).Hours()/24) + 1
	if days > 1500 {
		days = 1500
	}
	for _, sym := range info.Symbols {
		if sym.ContractType != "PERPETUAL" || sym.Status != "TRADING" {
			continue
		}
		total++
		if err := th.wait(ctx); err != nil {
			return out, err
		}
		var klines [][]any
		u := fmt.Sprintf("https://fapi.asterdex.com/fapi/v1/klines?symbol=%s&interval=1d&startTime=%d&endTime=%d&limit=%d",
			url.QueryEscape(sym.Symbol), from.UnixMilli(), to.AddDate(0, 0, 1).UnixMilli()-1, days)
		if err := getJSON(ctx, u, &klines); err != nil {
			failed++
			continue
		}
		for _, k := range klines {
			if len(k) < 8 {
				continue
			}
			openMs, ok := toFloat(k[0])
			if !ok {
				continue
			}
			d := utcDay(time.UnixMilli(int64(openMs)))
			if !inRange(d, from, to) {
				continue
			}
			qv, _ := toFloat(k[7])
			out[d] += qv
		}
	}
	if total > 0 && failed > total/2 {
		return nil, fmt.Errorf("%d of %d symbols failed", failed, total)
	}
	return out, nil
}
