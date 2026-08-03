package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Polymarket US (QCX) is the CFTC-regulated DCM operated by QCX Inc,
// accessible at https://polymarketexchange.com. It mirrors the Polymarket
// Global market catalog under CFTC supervision and offers retail access
// via Robinhood.
//
// Public API: https://gateway.polymarket.us/v1
//   GET /markets?limit=100&offset=N&active=true&closed=false
//   Returns up to 100 market rows, no volume/OI fields.
//
// Volume and OI are NOT available in the public REST catalog:
//   - The /markets list only carries bid/ask quotes and market metadata.
//   - The /markets/{slug}/bbo endpoint gives per-market OI but would
//     require one request per market — prohibitive for a 30k+ catalog.
//   - There is no /stats aggregate endpoint.
//
// We therefore publish:
//   pm_venue_active_markets{venue="polymarket-us"}   counted from pagination
//   (all other pm_venue_* gauges stay at their zero default = null in Prom)
//
// Rate budget: 50 pages * 100 markets = 5000 markets counted per tick.
// At 5-min tick intervals and 20 req/s gateway cap: ~0.1 req/s average,
// well within budget.

const (
	polymarketUSBase     = "https://gateway.polymarket.us"
	polymarketUSMaxPages = 50
	polymarketUSLimit    = 100
	polymarketUSUA       = "OCB-pm-cohort-stats/1.0 (+https://openchainbench.com/methodology; contact@mobula.io)"
)

var httpClientPolymarketUS = &http.Client{Timeout: 15 * time.Second}

type polymarketUSMarket struct {
	Active bool   `json:"active"`
	Closed bool   `json:"closed"`
	Slug   string `json:"slug"`
}

type polymarketUSListResponse struct {
	Markets []polymarketUSMarket `json:"markets"`
}

// fetchAllPolymarketUS counts active markets on Polymarket US and writes
// pm_venue_active_markets{venue="polymarket-us"}. Volume and OI remain at
// their zero default because the public gateway does not expose aggregate
// financial metrics.
func fetchAllPolymarketUS() {
	start := time.Now()
	const slug = "polymarket-us"
	const source = "gateway-polymarket-us"

	activeCount, err := countPolymarketUSActiveMarkets()
	if err != nil {
		pmCohortStatsFetchErrors.WithLabelValues(slug, source, classifyError(err.Error())).Inc()
		fmt.Printf("[polymarket-us] count error: %v\n", err)
		return
	}

	pmVenueActiveMarkets.WithLabelValues(slug).Set(float64(activeCount))
	pmCohortStatsLastRefresh.WithLabelValues(slug, source).SetToCurrentTime()
	pmCohortStatsFetchLatencyMs.WithLabelValues(slug, source).Set(float64(time.Since(start).Milliseconds()))
	pmCohortStatsLastTickUnix.SetToCurrentTime()
	fmt.Printf("[polymarket-us] active_markets=%d latency=%dms\n", activeCount, time.Since(start).Milliseconds())
}

func countPolymarketUSActiveMarkets() (int, error) {
	total := 0
	for page := 0; page < polymarketUSMaxPages; page++ {
		offset := page * polymarketUSLimit
		u, _ := url.Parse(polymarketUSBase + "/v1/markets")
		q := u.Query()
		q.Set("limit", fmt.Sprintf("%d", polymarketUSLimit))
		q.Set("offset", fmt.Sprintf("%d", offset))
		q.Set("active", "true")
		q.Set("closed", "false")
		u.RawQuery = q.Encode()

		req, err := http.NewRequest("GET", u.String(), nil)
		if err != nil {
			return total, fmt.Errorf("build request: %w", err)
		}
		req.Header.Set("User-Agent", polymarketUSUA)

		resp, err := httpClientPolymarketUS.Do(req)
		if err != nil {
			return total, fmt.Errorf("fetch page %d: %w", page, err)
		}

		var body polymarketUSListResponse
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			resp.Body.Close()
			return total, fmt.Errorf("decode page %d: %w", page, err)
		}
		resp.Body.Close()

		n := len(body.Markets)
		total += n
		if n < polymarketUSLimit {
			break
		}

		// Courtesy inter-page delay: stay well under the 20 req/s gateway cap.
		time.Sleep(150 * time.Millisecond)
	}
	return total, nil
}
