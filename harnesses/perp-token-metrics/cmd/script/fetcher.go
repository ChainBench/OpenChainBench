package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

// Base URLs are variables so tests can point them at an httptest server.
var (
	llamaBase = "https://api.llama.fi"
	cgBase    = "https://api.coingecko.com/api/v3"
)

func get(url string) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "OpenChainBench/1.0 perp-token-metrics")
	return httpClient.Do(req)
}

// llamaSeries is what we keep from one /summary/fees/<slug>?dataType=…
// response: the headline 24h number and the trailing windows we derive
// from totalDataChart ourselves, so every protocol is cut the same way
// regardless of which convenience fields the adapter happens to fill.
type llamaSeries struct {
	Total24h  float64
	Sum30d    float64 // last 30 daily points
	SumPrev30 float64 // the 30 points before those (days 31-60)
	Sum1y     float64 // last 365 daily points
	Avg30d    float64 // Sum30d / non-zero days in the window
	Days30    int     // non-zero days counted in Avg30d
}

// fetchLlamaSeries returns the trailing windows for one DeFiLlama slug and
// data type ("dailyFees" or "dailyRevenue"). ok is false on transport or
// decode failure, or when the chart is empty; a chart of zeros is ok=true
// with zero sums, which is a real observation (adapter live, nothing earned).
func fetchLlamaSeries(slug, dataType string) (llamaSeries, bool) {
	url := fmt.Sprintf("%s/summary/fees/%s?dataType=%s", llamaBase, slug, dataType)
	resp, err := get(url)
	if err != nil || resp.StatusCode != 200 {
		return llamaSeries{}, false
	}
	defer resp.Body.Close()

	var d struct {
		Total24h       float64          `json:"total24h"`
		TotalDataChart [][2]json.Number `json:"totalDataChart"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		return llamaSeries{}, false
	}
	if len(d.TotalDataChart) == 0 {
		return llamaSeries{}, false
	}
	return windowsFromChart(d.Total24h, d.TotalDataChart), true
}

// windowsFromChart cuts the trailing windows out of a DeFiLlama
// totalDataChart ([[unixDay, value], …]). Points are sorted by timestamp
// first because the API does not promise order. The current partial day
// is not special-cased: DeFiLlama's own 30d figure includes it too.
func windowsFromChart(total24h float64, chart [][2]json.Number) llamaSeries {
	type pt struct {
		t int64
		v float64
	}
	pts := make([]pt, 0, len(chart))
	for _, c := range chart {
		t, err1 := c[0].Int64()
		v, err2 := c[1].Float64()
		if err1 != nil || err2 != nil {
			continue
		}
		pts = append(pts, pt{t, v})
	}
	sort.Slice(pts, func(i, j int) bool { return pts[i].t < pts[j].t })

	s := llamaSeries{Total24h: total24h}
	n := len(pts)
	for i := n - 1; i >= 0 && i >= n-365; i-- {
		v := pts[i].v
		s.Sum1y += v
		back := n - 1 - i // 0 = latest day
		switch {
		case back < 30:
			s.Sum30d += v
			if v > 0 {
				s.Days30++
			}
		case back < 60:
			s.SumPrev30 += v
		}
	}
	if s.Days30 > 0 {
		s.Avg30d = s.Sum30d / float64(s.Days30)
	}
	return s
}

// cgMarket is the slice of CoinGecko /coins/markets we use.
type cgMarket struct {
	Mcap        float64
	FDV         float64
	Circ        float64
	TotalSupply float64
}

// fetchCGMarkets fetches market cap, FDV and supply for many CoinGecko IDs
// in one request. Missing IDs are simply absent from the map.
func fetchCGMarkets(ids []string) map[string]cgMarket {
	result := map[string]cgMarket{}
	if len(ids) == 0 {
		return result
	}
	url := fmt.Sprintf(
		"%s/coins/markets?vs_currency=usd&ids=%s&per_page=100&sparkline=false",
		cgBase, strings.Join(ids, ","),
	)
	resp, err := get(url)
	if err != nil || resp.StatusCode != 200 {
		return result
	}
	defer resp.Body.Close()

	var coins []struct {
		ID              string   `json:"id"`
		MarketCap       *float64 `json:"market_cap"`
		FullyDilutedVal *float64 `json:"fully_diluted_valuation"`
		Circulating     *float64 `json:"circulating_supply"`
		TotalSupply     *float64 `json:"total_supply"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&coins); err != nil {
		return result
	}
	deref := func(p *float64) float64 {
		if p == nil {
			return 0
		}
		return *p
	}
	for _, c := range coins {
		m := cgMarket{
			Mcap:        deref(c.MarketCap),
			FDV:         deref(c.FullyDilutedVal),
			Circ:        deref(c.Circulating),
			TotalSupply: deref(c.TotalSupply),
		}
		// CoinGecko leaves FDV null when total supply is unknown; the
		// existing P/E bench fell back to mcap and we keep that.
		if m.FDV == 0 {
			m.FDV = m.Mcap
		}
		if m.Mcap > 0 || m.FDV > 0 {
			result[c.ID] = m
		}
	}
	return result
}

// fetchLlamaOpenInterest returns current open interest in USD keyed by
// DeFiLlama perps slug (the overview lists child protocols only). An
// empty map on failure just leaves the OI-derived gauges unset.
func fetchLlamaOpenInterest() map[string]float64 {
	result := map[string]float64{}
	url := llamaBase + "/overview/open-interest?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true"
	resp, err := get(url)
	if err != nil || resp.StatusCode != 200 {
		return result
	}
	defer resp.Body.Close()

	var d struct {
		Protocols []struct {
			Slug     string   `json:"slug"`
			Total24h *float64 `json:"total24h"`
		} `json:"protocols"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		return result
	}
	for _, p := range d.Protocols {
		if p.Total24h != nil && *p.Total24h > 0 {
			result[p.Slug] = *p.Total24h
		}
	}
	return result
}
