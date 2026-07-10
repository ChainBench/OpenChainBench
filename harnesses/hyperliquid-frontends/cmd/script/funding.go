package main

// Perp funding-rate module (OCB bench perp-funding). Polls the public
// funding endpoint of each venue, normalizes by the venue's own funding
// interval (HL/dYdX pay hourly, Binance/Bybit/OKX/Paradex/Aster settle on
// 4h/8h periods), and republishes per-hour, per-24h-hold, and annualized
// figures so the bench compares venues on the same time base.
//
// Sign convention everywhere: positive = longs pay shorts.
// On poll error a venue's gauges keep their previous values and its
// ok-timestamp goes stale, which the bench's success query surfaces.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var fundingAssets = []string{"BTC", "ETH", "SOL"}

var (
	fundingHourlyBps = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_funding_rate_hourly_bps",
		Help: "Funding rate normalized to a per-hour basis, in bps. Positive = longs pay shorts",
	}, []string{"venue", "asset"})
	fundingHold24hBps = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_funding_hold_24h_bps",
		Help: "Funding cost of holding a long for 24h at the current rate, in bps of notional",
	}, []string{"venue", "asset"})
	fundingAnnualizedPct = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_funding_annualized_pct",
		Help: "Current funding rate annualized, in percent",
	}, []string{"venue", "asset"})
	fundingIntervalHours = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_funding_interval_hours",
		Help: "Venue's native funding settlement interval for the asset, in hours",
	}, []string{"venue", "asset"})
	fundingVenueOkUnix = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_funding_venue_ok_unix",
		Help: "Unix time of the venue's last successful funding poll",
	}, []string{"venue"})
	fundingLastTick = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "perp_funding_last_tick_unix",
		Help: "Unix time of the last funding poll cycle",
	})
)

type fundingPoint struct {
	// Rate per the venue's native interval, decimal (0.0001 = 1 bp).
	rate float64
	// Native settlement interval in hours.
	intervalH float64
}

type fundingVenue struct {
	name string
	poll func(ctx context.Context) (map[string]fundingPoint, error)
}

var fundingHTTP = &http.Client{Timeout: 10 * time.Second}

func fundingGetJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := fundingHTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 200))
		return fmt.Errorf("%s: http %d: %s", url, res.StatusCode, b)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func parseRate(s string) (float64, error) { return strconv.ParseFloat(s, 64) }

// ── Hyperliquid: metaAndAssetCtxs, funding field is the live 1h rate ──

func pollHyperliquid(ctx context.Context) (map[string]fundingPoint, error) {
	body := bytes.NewBufferString(`{"type":"metaAndAssetCtxs"}`)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.hyperliquid.xyz/info", body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := fundingHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hl: http %d", res.StatusCode)
	}
	var raw []json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, err
	}
	if len(raw) != 2 {
		return nil, fmt.Errorf("hl: unexpected envelope")
	}
	var meta struct {
		Universe []struct {
			Name string `json:"name"`
		} `json:"universe"`
	}
	var ctxs []struct {
		Funding string `json:"funding"`
	}
	if err := json.Unmarshal(raw[0], &meta); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw[1], &ctxs); err != nil {
		return nil, err
	}
	out := map[string]fundingPoint{}
	for i, u := range meta.Universe {
		if i >= len(ctxs) {
			break
		}
		for _, a := range fundingAssets {
			if u.Name == a {
				if r, err := parseRate(ctxs[i].Funding); err == nil {
					out[a] = fundingPoint{rate: r, intervalH: 1}
				}
			}
		}
	}
	return out, nil
}

// ── Binance-compatible (Binance, Aster): premiumIndex + fundingInfo ──

func pollBinanceLike(base, venue string) func(ctx context.Context) (map[string]fundingPoint, error) {
	return func(ctx context.Context) (map[string]fundingPoint, error) {
		// fundingInfo lists only symbols with a non-default interval;
		// everything else settles every 8h.
		intervals := map[string]float64{}
		var info []struct {
			Symbol               string `json:"symbol"`
			FundingIntervalHours int    `json:"fundingIntervalHours"`
		}
		if err := fundingGetJSON(ctx, base+"/fapi/v1/fundingInfo", &info); err == nil {
			for _, e := range info {
				if e.FundingIntervalHours > 0 {
					intervals[e.Symbol] = float64(e.FundingIntervalHours)
				}
			}
		} else {
			log.Printf("funding %s fundingInfo: %v (assuming 8h)", venue, err)
		}
		out := map[string]fundingPoint{}
		for _, a := range fundingAssets {
			sym := a + "USDT"
			var pi struct {
				LastFundingRate string `json:"lastFundingRate"`
			}
			if err := fundingGetJSON(ctx, base+"/fapi/v1/premiumIndex?symbol="+sym, &pi); err != nil {
				return nil, err
			}
			r, err := parseRate(pi.LastFundingRate)
			if err != nil {
				return nil, err
			}
			ih := intervals[sym]
			if ih == 0 {
				ih = 8
			}
			out[a] = fundingPoint{rate: r, intervalH: ih}
		}
		return out, nil
	}
}

// ── Bybit: v5 tickers + instruments-info (fundingInterval in minutes) ──

func pollBybit(ctx context.Context) (map[string]fundingPoint, error) {
	out := map[string]fundingPoint{}
	for _, a := range fundingAssets {
		sym := a + "USDT"
		var tick struct {
			Result struct {
				List []struct {
					FundingRate string `json:"fundingRate"`
				} `json:"list"`
			} `json:"result"`
		}
		if err := fundingGetJSON(ctx, "https://api.bybit.com/v5/market/tickers?category=linear&symbol="+sym, &tick); err != nil {
			return nil, err
		}
		if len(tick.Result.List) == 0 {
			return nil, fmt.Errorf("bybit: empty tickers for %s", sym)
		}
		r, err := parseRate(tick.Result.List[0].FundingRate)
		if err != nil {
			return nil, err
		}
		var inst struct {
			Result struct {
				List []struct {
					FundingInterval int `json:"fundingInterval"`
				} `json:"list"`
			} `json:"result"`
		}
		ih := 8.0
		if err := fundingGetJSON(ctx, "https://api.bybit.com/v5/market/instruments-info?category=linear&symbol="+sym, &inst); err == nil &&
			len(inst.Result.List) > 0 && inst.Result.List[0].FundingInterval > 0 {
			ih = float64(inst.Result.List[0].FundingInterval) / 60.0
		}
		out[a] = fundingPoint{rate: r, intervalH: ih}
	}
	return out, nil
}

// ── OKX: funding-rate, interval derived from settlement timestamps ──

func pollOKX(ctx context.Context) (map[string]fundingPoint, error) {
	out := map[string]fundingPoint{}
	for _, a := range fundingAssets {
		var resp struct {
			Data []struct {
				FundingRate     string `json:"fundingRate"`
				FundingTime     string `json:"fundingTime"`
				NextFundingTime string `json:"nextFundingTime"`
			} `json:"data"`
		}
		if err := fundingGetJSON(ctx, "https://www.okx.com/api/v5/public/funding-rate?instId="+a+"-USDT-SWAP", &resp); err != nil {
			return nil, err
		}
		if len(resp.Data) == 0 {
			return nil, fmt.Errorf("okx: empty data for %s", a)
		}
		d := resp.Data[0]
		r, err := parseRate(d.FundingRate)
		if err != nil {
			return nil, err
		}
		ih := 8.0
		cur, err1 := strconv.ParseInt(d.FundingTime, 10, 64)
		next, err2 := strconv.ParseInt(d.NextFundingTime, 10, 64)
		if err1 == nil && err2 == nil && next > cur {
			ih = float64(next-cur) / 3_600_000.0
		}
		out[a] = fundingPoint{rate: r, intervalH: ih}
	}
	return out, nil
}

// ── dYdX v4: indexer perpetualMarkets, nextFundingRate is per hour ──

func pollDydx(ctx context.Context) (map[string]fundingPoint, error) {
	out := map[string]fundingPoint{}
	for _, a := range fundingAssets {
		var resp struct {
			Markets map[string]struct {
				NextFundingRate string `json:"nextFundingRate"`
			} `json:"markets"`
		}
		t := a + "-USD"
		if err := fundingGetJSON(ctx, "https://indexer.dydx.trade/v4/perpetualMarkets?ticker="+t, &resp); err != nil {
			return nil, err
		}
		m, ok := resp.Markets[t]
		if !ok {
			return nil, fmt.Errorf("dydx: market %s missing", t)
		}
		r, err := parseRate(m.NextFundingRate)
		if err != nil {
			return nil, err
		}
		out[a] = fundingPoint{rate: r, intervalH: 1}
	}
	return out, nil
}

// ── Paradex: markets/summary, funding_rate is per 8h period ──

func pollParadex(ctx context.Context) (map[string]fundingPoint, error) {
	out := map[string]fundingPoint{}
	for _, a := range fundingAssets {
		var resp struct {
			Results []struct {
				FundingRate string `json:"funding_rate"`
			} `json:"results"`
		}
		if err := fundingGetJSON(ctx, "https://api.prod.paradex.trade/v1/markets/summary?market="+a+"-USD-PERP", &resp); err != nil {
			return nil, err
		}
		if len(resp.Results) == 0 {
			return nil, fmt.Errorf("paradex: empty summary for %s", a)
		}
		r, err := parseRate(resp.Results[0].FundingRate)
		if err != nil {
			return nil, err
		}
		out[a] = fundingPoint{rate: r, intervalH: 8}
	}
	return out, nil
}

// ── Polymarket perps: public info API, funding_rate is per 1h period ──

func pollPolymarket(ctx context.Context) (map[string]fundingPoint, error) {
	var tickers []struct {
		Symbol      string `json:"symbol"`
		FundingRate string `json:"funding_rate"`
	}
	if err := fundingGetJSON(ctx, "https://api.perpetuals.polymarket.com/v1/info/tickers", &tickers); err != nil {
		return nil, err
	}
	out := map[string]fundingPoint{}
	for _, t := range tickers {
		for _, a := range fundingAssets {
			if t.Symbol == a+"-USD" {
				r, err := parseRate(t.FundingRate)
				if err != nil {
					return nil, err
				}
				out[a] = fundingPoint{rate: r, intervalH: 1}
			}
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("polymarket: no funding assets in tickers")
	}
	return out, nil
}

var fundingVenues = []fundingVenue{
	{name: "hyperliquid", poll: pollHyperliquid},
	{name: "binance", poll: pollBinanceLike("https://fapi.binance.com", "binance")},
	{name: "bybit", poll: pollBybit},
	{name: "okx", poll: pollOKX},
	{name: "dydx", poll: pollDydx},
	{name: "paradex", poll: pollParadex},
	{name: "aster", poll: pollBinanceLike("https://fapi.asterdex.com", "aster")},
	{name: "polymarket", poll: pollPolymarket},
}

func runFundingLoop(ctx context.Context, every time.Duration) {
	tick := func() {
		cctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		var wg sync.WaitGroup
		for _, v := range fundingVenues {
			wg.Add(1)
			go func(v fundingVenue) {
				defer wg.Done()
				points, err := v.poll(cctx)
				if err != nil {
					log.Printf("funding %s: %v", v.name, err)
					return
				}
				for asset, p := range points {
					if p.intervalH <= 0 {
						continue
					}
					hourly := p.rate / p.intervalH
					fundingHourlyBps.WithLabelValues(v.name, asset).Set(hourly * 10_000)
					fundingHold24hBps.WithLabelValues(v.name, asset).Set(hourly * 24 * 10_000)
					fundingAnnualizedPct.WithLabelValues(v.name, asset).Set(hourly * 24 * 365 * 100)
					fundingIntervalHours.WithLabelValues(v.name, asset).Set(p.intervalH)
				}
				if len(points) > 0 {
					fundingVenueOkUnix.WithLabelValues(v.name).SetToCurrentTime()
				}
			}(v)
		}
		wg.Wait()
		fundingLastTick.SetToCurrentTime()
	}

	tick()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}
