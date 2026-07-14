package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// RedStone freshness poller (bench № 082 only). RedStone is a
// modular oracle: signed data packages are produced off-chain on a
// ~10s cadence and delivered on-chain either by relayers (push
// model) or attached to transactions by the integrator (pull model,
// "core"). The freshest public view of the primary production
// service is the keyless per-symbol price API, which returns the
// latest signed package's value and timestamp. We deliberately avoid
// the data-packages gateway's full-service payload (~1.7 MB per
// request for redstone-primary-prod) and poll one small per-symbol
// object per pair instead.
//
// RedStone samples feed ONLY the freshness metrics. They never enter
// the 025 deviation store: bench 025 is a fixed 4-source matrix
// (chainlink/pyth/binance/coinbase) and its queries count sources per
// pair, so adding a 5th source would silently change its numbers.

type redstonePrice struct {
	Symbol    string  `json:"symbol"`
	Value     float64 `json:"value"`
	Timestamp int64   `json:"timestamp"` // unix milliseconds
}

func runRedstone(ctx context.Context, feeds []RedstoneFeed) {
	client := &http.Client{Timeout: httpTimeout}
	t := time.NewTicker(pollInterval)
	defer t.Stop()

	tick := func() {
		for _, f := range feeds {
			pollCtx, cancel := context.WithTimeout(ctx, httpTimeout)
			ts, err := fetchRedstone(pollCtx, client, f.Symbol)
			cancel()
			if err != nil {
				freshnessScrapeErrors.WithLabelValues("redstone", string(f.Pair), ChainGateway).Inc()
				fmt.Printf("[redstone/%s] err: %v\n", f.Pair, err)
				continue
			}
			recordFreshness("redstone", f.Pair, ChainGateway, ts)
		}
	}

	tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

// fetchRedstone returns the timestamp of the latest signed data
// package for one symbol. GET /prices?symbol=<S>&provider=redstone&limit=1
// answers with a one-element array; timestamp is unix ms.
func fetchRedstone(ctx context.Context, client *http.Client, symbol string) (time.Time, error) {
	u := redstoneBaseURL() + "?symbol=" + url.QueryEscape(symbol) + "&provider=redstone&limit=1"
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return time.Time{}, err
	}
	req.Header.Set("User-Agent", "openchainbench-oracle-freshness/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return time.Time{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return time.Time{}, fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var arr []redstonePrice
	if err := json.Unmarshal(body, &arr); err != nil {
		return time.Time{}, fmt.Errorf("decode: %w", err)
	}
	if len(arr) == 0 {
		return time.Time{}, fmt.Errorf("empty result for %s", symbol)
	}
	p := arr[0]
	if p.Value <= 0 {
		return time.Time{}, fmt.Errorf("non-positive value %v for %s", p.Value, symbol)
	}
	if p.Timestamp <= 0 {
		return time.Time{}, fmt.Errorf("missing timestamp for %s", symbol)
	}
	return time.UnixMilli(p.Timestamp), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
