package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------
// GMX V2 (dimension-adapters/dexs/gmx-v2-gmx-v2-trade.ts)
// ---------------------------------------------------------------------

// gmxSource reads the GMX synthetics squids, one per chain:
// volumeInfos(period "1d").marginVolumeUsd scaled by 1e-30, summed over
// chains. marginVolumeUsd is perps only (swaps are a separate field), so
// this is the "GMX V2 Perps" line on DeFiLlama. Arbitrum is required;
// the other chains are additive and a squid that 404s (Botanix did on
// 2026-09-14) is skipped for that sweep rather than failing the venue.
type gmxSource struct{ meta venueMeta }

var gmxSquids = []struct{ chain, url string }{
	{"arbitrum", "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql"},
	{"avalanche", "https://gmx.squids.live/gmx-synthetics-avalanche:prod/api/graphql"},
	{"botanix", "https://gmx.squids.live/gmx-synthetics-botanix:prod/api/graphql"},
	{"megaeth", "https://gmx.squids.live/gmx-synthetics-megaeth:prod/api/graphql"},
}

func (s *gmxSource) Slug() string        { return s.meta.slug }
func (s *gmxSource) DisplayName() string { return s.meta.name }
func (s *gmxSource) Name() string        { return "gmx-squid" }
func (s *gmxSource) Note() string {
	return "GMX V2 synthetics squids, marginVolumeUsd (perps only, swaps excluded), Arbitrum + Avalanche + Botanix + MegaETH"
}
func (s *gmxSource) Start() time.Time { return s.meta.start }

func (s *gmxSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	days := int(to.Sub(from).Hours()/24) + 1
	limit := days + 5
	if limit > 2000 {
		limit = 2000
	}
	q := fmt.Sprintf(`{ volumeInfos(where: {period_eq: "1d"}, orderBy: timestamp_DESC, limit: %d) { timestamp marginVolumeUsd } }`, limit)
	out := map[time.Time]float64{}
	gotArbitrum := false
	for _, sq := range gmxSquids {
		var resp struct {
			Data struct {
				VolumeInfos []struct {
					Timestamp       int64  `json:"timestamp"`
					MarginVolumeUsd string `json:"marginVolumeUsd"`
				} `json:"volumeInfos"`
			} `json:"data"`
		}
		if err := postJSON(ctx, sq.url, map[string]string{"query": q}, &resp); err != nil {
			if sq.chain == "arbitrum" {
				return nil, fmt.Errorf("arbitrum squid: %w", err)
			}
			fmt.Printf("[gmx][%s] skipped: %v\n", sq.chain, err)
			continue
		}
		if sq.chain == "arbitrum" {
			gotArbitrum = true
		}
		for _, r := range resp.Data.VolumeInfos {
			d := utcDay(time.Unix(r.Timestamp, 0))
			if !inRange(d, from, to) {
				continue
			}
			out[d] += scale1e30(r.MarginVolumeUsd)
		}
	}
	if !gotArbitrum {
		return nil, fmt.Errorf("arbitrum squid returned nothing")
	}
	return out, nil
}

// scale1e30 converts a 30-decimals fixed-point decimal string to a
// float64 in USD without going through big.Int: the integer part of
// a USD amount fits comfortably in float64 precision here.
func scale1e30(s string) float64 {
	s = strings.TrimSpace(s)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	if len(s) <= 30 {
		s = strings.Repeat("0", 31-len(s)) + s
	}
	whole := s[:len(s)-30]
	frac := s[len(s)-30:]
	if len(frac) > 6 {
		frac = frac[:6]
	}
	v, err := strconv.ParseFloat(whole+"."+frac, 64)
	if err != nil {
		return 0
	}
	if neg {
		return -v
	}
	return v
}

// ---------------------------------------------------------------------
// Gains Network (dimension-adapters/dexs/gains-network/index.ts)
// ---------------------------------------------------------------------

// gainsSource has two upstreams for the same number:
//
//   - The Dune view dune.gains.result_g_trade_stats_defi_llama, which is
//     what DeFiLlama's adapter reads (Arbitrum, Polygon, Base, MegaETH;
//     ApeChain is added by DeFiLlama from events and is not in the view).
//     Used when DUNE_API_KEY is set. One execution returns the whole
//     history, so a sweep costs one query.
//   - The Gains backend /api/volume-mix?from=D&to=D, autoVolumeUsd +
//     directVolumeUsd: opens and closes at full notional, resizes at
//     their traded delta, gov-only rows excluded. That is the trade
//     perimeter of the Dune view. Same chains minus ApeChain (the
//     backend reports 33139 in missingChainIds). One call per day,
//     rate limited to 30/min upstream.
//
// With the key set, the Dune figure is published and the backend figure
// is kept for the divergence gauge; without it the backend figure is
// published.
//
// Dune executions cost credits (about 10 per run on the free tier's
// 2,500 a month), so the view is queried at most every
// DUNE_MIN_INTERVAL_HOURS (default 12, about 60 runs a month). In
// between, the backend fills only the days the view has not produced
// yet (a fresh D-1), so a day never flips between the two conventions.
type gainsSource struct {
	meta         venueMeta
	duneKey      string
	duneQID      string
	duneInterval time.Duration
	lastDune     time.Time
	duneDays     map[time.Time]bool
	throttle     *throttle
}

func newGainsSource(v venueMeta) *gainsSource {
	return &gainsSource{
		meta:         v,
		duneKey:      os.Getenv("DUNE_API_KEY"),
		duneQID:      env("DUNE_SQL_QUERY_ID", "3996608"),
		duneInterval: time.Duration(envInt("DUNE_MIN_INTERVAL_HOURS", 12)) * time.Hour,
		duneDays:     map[time.Time]bool{},
		throttle:     newThrottle(24),
	}
}

func (s *gainsSource) Slug() string        { return s.meta.slug }
func (s *gainsSource) DisplayName() string { return s.meta.name }
func (s *gainsSource) Name() string {
	if s.duneKey != "" {
		return "gains-dune-view"
	}
	return "gains-backend"
}
func (s *gainsSource) Note() string {
	if s.duneKey != "" {
		return "Dune view dune.gains.result_g_trade_stats_defi_llama (the DeFiLlama adapter's source): Arbitrum, Polygon, Base, MegaETH; ApeChain not included"
	}
	return "Gains backend volume-mix, auto + direct notional (resizes at traded delta): Arbitrum, Polygon, Base, MegaETH; ApeChain not included"
}
func (s *gainsSource) Start() time.Time { return s.meta.start }

func (s *gainsSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	backend, backendErr := s.dailyBackend(ctx, from, to)
	if s.duneKey == "" {
		return backend, backendErr
	}
	if !s.lastDune.IsZero() && time.Since(s.lastDune) < s.duneInterval {
		// Dune not due: publish the backend figure only for days the
		// view has not covered yet.
		out := map[time.Time]float64{}
		for d, v := range backend {
			if !s.duneDays[d] {
				out[d] = v
			}
		}
		return out, backendErr
	}
	dune, err := s.dailyDune(ctx, from, to)
	if err != nil {
		fmt.Printf("[gains][dune] err: %v (publishing backend figure)\n", err)
		return backend, backendErr
	}
	s.lastDune = time.Now()
	for d := range dune {
		s.duneDays[d] = true
	}
	if backendErr == nil {
		var sumD, sumB float64
		for d, v := range dune {
			if b, ok := backend[d]; ok {
				sumD += v
				sumB += b
			}
		}
		if sumD > 0 && sumB > 0 {
			divergence.WithLabelValues(s.meta.slug, "gains-backend").Set((sumB - sumD) / sumD * 100)
		}
	}
	return dune, nil
}

func (s *gainsSource) dailyBackend(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	out := map[time.Time]float64{}
	var firstErr error
	err := eachDay(ctx, from, to, func(d time.Time) error {
		if err := s.throttle.wait(ctx); err != nil {
			return err
		}
		var resp struct {
			AutoVolumeUsd   float64 `json:"autoVolumeUsd"`
			DirectVolumeUsd float64 `json:"directVolumeUsd"`
			TotalVolumeUsd  float64 `json:"totalVolumeUsd"`
			LastTradeTS     int64   `json:"lastTradeTimestamp"`
		}
		url := fmt.Sprintf("https://backend-global.gains.trade/api/volume-mix?from=%s&to=%s", fmtDay(d), fmtDay(d))
		if err := getJSON(ctx, url, &resp); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			fmt.Printf("[gains][backend] %s err: %v\n", fmtDay(d), err)
			return nil
		}
		out[d] = resp.AutoVolumeUsd + resp.DirectVolumeUsd
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

func (s *gainsSource) dailyDune(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	sql := fmt.Sprintf(`select unix_ts, blockchain, daily_volume
from dune.gains.result_g_trade_stats_defi_llama
where day >= date '%s' and day <= date '%s'
order by unix_ts, blockchain`, fmtDay(from), fmtDay(to))
	rows, err := runDuneSQL(ctx, s.duneKey, s.duneQID, sql)
	if err != nil {
		return nil, err
	}
	out := map[time.Time]float64{}
	for _, r := range rows {
		ts, _ := toFloat(r["unix_ts"])
		usd, _ := toFloat(r["daily_volume"])
		if ts == 0 {
			continue
		}
		d := utcDay(time.Unix(int64(ts), 0))
		if inRange(d, from, to) {
			out[d] += usd
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("dune view returned no rows")
	}
	return out, nil
}

// runDuneSQL executes arbitrary SQL through a saved Dune query that
// forwards its fullQuery parameter (the public query 3996608 does), then
// polls the execution and pages the results.
func runDuneSQL(ctx context.Context, key, queryID, sql string) ([]map[string]any, error) {
	const api = "https://api.dune.com/api/v1"
	hdr := map[string]string{"X-Dune-API-Key": key}
	var started struct {
		ExecutionID string `json:"execution_id"`
	}
	body := map[string]any{"query_parameters": map[string]string{"fullQuery": sql}}
	if err := doJSONHeaders(ctx, "POST", api+"/query/"+queryID+"/execute", body, hdr, &started); err != nil {
		return nil, fmt.Errorf("execute: %w", err)
	}
	if started.ExecutionID == "" {
		return nil, fmt.Errorf("execute: no execution_id")
	}
	deadline := time.Now().Add(4 * time.Minute)
	for {
		var st struct {
			State string `json:"state"`
		}
		if err := doJSONHeaders(ctx, "GET", api+"/execution/"+started.ExecutionID+"/status", nil, hdr, &st); err != nil {
			return nil, fmt.Errorf("status: %w", err)
		}
		if st.State == "QUERY_STATE_COMPLETED" {
			break
		}
		if st.State == "QUERY_STATE_FAILED" || st.State == "QUERY_STATE_CANCELLED" || st.State == "QUERY_STATE_EXPIRED" {
			return nil, fmt.Errorf("execution %s", st.State)
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("execution still %s after 4m", st.State)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	var rows []map[string]any
	for offset := 0; ; offset += 1000 {
		var page struct {
			Result struct {
				Rows []map[string]any `json:"rows"`
			} `json:"result"`
		}
		url := fmt.Sprintf("%s/execution/%s/results?limit=1000&offset=%d", api, started.ExecutionID, offset)
		if err := doJSONHeaders(ctx, "GET", url, nil, hdr, &page); err != nil {
			return nil, fmt.Errorf("results: %w", err)
		}
		rows = append(rows, page.Result.Rows...)
		if len(page.Result.Rows) < 1000 {
			break
		}
	}
	return rows, nil
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int64:
		return float64(x), true
	case string:
		f, err := strconv.ParseFloat(x, 64)
		return f, err == nil
	}
	return 0, false
}

// ---------------------------------------------------------------------
// Hyperliquid (dimension-adapters/dexs/hyperliquid-perp)
// ---------------------------------------------------------------------

// hyperliquidSource rebuilds daily perp notional from the public info
// API: candleSnapshot 1h for every perp market on every perp dex (the
// main dex plus HIP-3 dexs from perpDexs), notional per hour = base
// volume x hourly mean price (o+h+l+c)/4, summed per UTC day. DeFiLlama
// reads its own fill indexer for this series and its old public stats
// feed (cloudfront daily_usd_volume) stopped on 2026-04-03; hourly
// candles keep the price approximation well under one percent on the
// day. candleSnapshot returns at most 5000 candles, so a long backfill
// pages by 200 days.
type hyperliquidSource struct{ meta venueMeta }

func (s *hyperliquidSource) Slug() string        { return s.meta.slug }
func (s *hyperliquidSource) DisplayName() string { return s.meta.name }
func (s *hyperliquidSource) Name() string        { return "hl-info-candles" }
func (s *hyperliquidSource) Note() string {
	return "Hyperliquid info candleSnapshot 1h, base volume x hourly mean price, all perp markets including HIP-3 dexs"
}
func (s *hyperliquidSource) Start() time.Time { return s.meta.start }

const hlInfo = "https://api.hyperliquid.xyz/info"

func (s *hyperliquidSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	var dexs []*struct {
		Name string `json:"name"`
	}
	if err := postJSON(ctx, hlInfo, map[string]string{"type": "perpDexs"}, &dexs); err != nil {
		return nil, fmt.Errorf("perpDexs: %w", err)
	}
	type coin struct{ name string }
	var coins []coin
	for _, dx := range dexs {
		req := map[string]string{"type": "meta"}
		if dx != nil && dx.Name != "" {
			req["dex"] = dx.Name
		}
		var meta struct {
			Universe []struct {
				Name string `json:"name"`
			} `json:"universe"`
		}
		if err := postJSON(ctx, hlInfo, req, &meta); err != nil {
			if dx == nil {
				return nil, fmt.Errorf("meta: %w", err)
			}
			fmt.Printf("[hyperliquid] dex %s meta skipped: %v\n", dx.Name, err)
			continue
		}
		for _, u := range meta.Universe {
			coins = append(coins, coin{u.Name})
		}
	}
	out := map[time.Time]float64{}
	th := newThrottle(90)
	failed := 0
	for _, c := range coins {
		// Page by 200 days: 4800 hourly candles per request.
		for pageEnd := to.AddDate(0, 0, 1); pageEnd.After(from); pageEnd = pageEnd.AddDate(0, 0, -200) {
			pageStart := pageEnd.AddDate(0, 0, -200)
			if pageStart.Before(from) {
				pageStart = from
			}
			if err := th.wait(ctx); err != nil {
				return out, err
			}
			var candles []struct {
				T int64  `json:"t"`
				O string `json:"o"`
				H string `json:"h"`
				L string `json:"l"`
				C string `json:"c"`
				V string `json:"v"`
			}
			req := map[string]any{"type": "candleSnapshot", "req": map[string]any{
				"coin": c.name, "interval": "1h",
				"startTime": pageStart.UnixMilli(), "endTime": pageEnd.UnixMilli() - 1,
			}}
			if err := postJSON(ctx, hlInfo, req, &candles); err != nil {
				failed++
				break
			}
			for _, k := range candles {
				d := utcDay(time.UnixMilli(k.T))
				if !inRange(d, from, to) {
					continue
				}
				o, _ := strconv.ParseFloat(k.O, 64)
				h, _ := strconv.ParseFloat(k.H, 64)
				l, _ := strconv.ParseFloat(k.L, 64)
				cl, _ := strconv.ParseFloat(k.C, 64)
				v, _ := strconv.ParseFloat(k.V, 64)
				out[d] += v * (o + h + l + cl) / 4
			}
			if len(candles) == 0 {
				// No candles this page: the market did not exist yet.
				break
			}
		}
	}
	if len(coins) > 0 && failed > len(coins)/2 {
		return nil, fmt.Errorf("%d of %d markets failed", failed, len(coins))
	}
	return out, nil
}
