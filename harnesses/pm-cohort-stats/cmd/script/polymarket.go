package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// flexFloat tolerates JSON values that are either a number or a stringified
// number. Polymarket gamma-api returns `volume` as a string while
// `volume24hr` and `volume1mo` come back as raw floats; Kalshi returns
// `volume_24h_fp`, `open_interest_fp`, `last_price_dollars` as strings.
// Using a custom unmarshaler keeps the struct definitions clean.
type flexFloat float64

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	if b[0] == '"' {
		// Strip surrounding quotes.
		s := string(b[1 : len(b)-1])
		if s == "" {
			return nil
		}
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return err
		}
		*f = flexFloat(v)
		return nil
	}
	var v float64
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*f = flexFloat(v)
	return nil
}

// Polymarket exposes its market catalog on a public unauthenticated
// gamma-api host. We paginate /markets?closed=false&active=true&limit=500
// via the `offset` query parameter and aggregate per-row counters:
//
//   volume24hr        sum  ->  pm_venue_volume_24h_usd{venue=polymarket}
//   volume1mo         sum  ->  pm_venue_volume_30d_usd{venue=polymarket}
//   openInterest      sum  ->  pm_venue_open_interest_usd{venue=polymarket}
//                     count ->  pm_venue_active_markets{venue=polymarket}
//   max(volume24hr)        ->  pm_venue_top_market_volume_24h_usd
//   count(volume>=1m)      ->  pm_venue_markets_above_1m
//
// Pagination safety cap is 20 pages * 500 rows = 10k markets; the live
// open set is < 5k today. If gamma-api stops returning rows before the
// cap, we stop. Errors at any point are bucketed and we publish only
// the metrics we successfully computed (partial publication > silence,
// since the Prom carry-forward already covers a totally failed tick).

const (
	polymarketBase = "https://gamma-api.polymarket.com"
	// gamma-api caps server-side at 100 rows per page regardless of the
	// `limit` we ask, so the stride is 100. We still pass limit=500 to
	// future-proof in case the cap is lifted; the loop terminates on the
	// first empty page or when polymarketMaxPages is reached. At 100 rows
	// per page the cap covers up to 10k open markets (the live open set is
	// well under that today).
	polymarketLimit    = 500
	polymarketStride   = 100
	polymarketMaxPages = 100
	polymarketUA       = "OCB-pm-cohort-stats/1.0"
)

var httpClientPolymarket = &http.Client{Timeout: 20 * time.Second}

func fetchAllPolymarket() {
	v := VenueBySlug("polymarket")
	if v == nil {
		return
	}
	go fetchPolymarketVenue(*v)
}

type polymarketMarket struct {
	Volume24hr   flexFloat `json:"volume24hr"`
	Volume1mo    flexFloat `json:"volume1mo"`
	Volume       flexFloat `json:"volume"`
	OpenInterest flexFloat `json:"openInterest"`
	ConditionID  string    `json:"conditionId"`
	Closed       bool      `json:"closed"`
	Active       bool      `json:"active"`
}

func fetchPolymarketVenue(v Venue) {
	start := time.Now()
	defer func() {
		pmCohortStatsFetchLatencyMs.WithLabelValues(v.Slug, "polymarket").Set(float64(time.Since(start).Milliseconds()))
	}()

	var (
		vol24Sum     float64
		vol30Sum     float64
		oiSum        float64
		activeCount  float64
		topVol24     float64
		above1mCount float64
		pagesOK      int
	)

	for page := 0; page < polymarketMaxPages; page++ {
		offset := page * polymarketStride
		url := fmt.Sprintf("%s/markets?closed=false&active=true&limit=%d&offset=%d", polymarketBase, polymarketLimit, offset)
		body, err := getJSON(httpClientPolymarket, url)
		if err != nil {
			// gamma-api returns status_422 with `offset too large` once we
			// pass the deep-pagination ceiling. Treat it as a clean
			// end-of-list rather than a fetch failure so the error counter
			// stays meaningful for real outages.
			if contains(err.Error(), "status_422") && contains(err.Error(), "offset too large") {
				break
			}
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "polymarket", classifyError(err.Error())).Inc()
			fmt.Printf("[polymarket][%s] page=%d error: %v\n", v.Slug, page, err)
			break
		}
		var rows []polymarketMarket
		if err := json.Unmarshal(body, &rows); err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "polymarket", "parse").Inc()
			fmt.Printf("[polymarket][%s] page=%d parse error: %v\n", v.Slug, page, err)
			break
		}
		if len(rows) == 0 {
			break
		}
		for _, r := range rows {
			if r.Closed {
				continue
			}
			v24 := float64(r.Volume24hr)
			v30 := float64(r.Volume1mo)
			oi := float64(r.OpenInterest)
			vTot := float64(r.Volume)
			vol24Sum += v24
			vol30Sum += v30
			oiSum += oi
			activeCount++
			if v24 > topVol24 {
				topVol24 = v24
			}
			if vTot >= 1_000_000 {
				above1mCount++
			}
		}
		pagesOK++
		// Terminate only on a fully empty page (gamma-api server-side caps
		// page-size to ~100 even when we ask 500, so a partial page is
		// expected and is NOT an end-of-list signal).
	}

	if pagesOK == 0 {
		// Total miss; gauges left untouched via Prom carry-forward.
		pmCohortStatsLastTickUnix.Set(float64(time.Now().Unix()))
		return
	}

	pmVenueVolume24hUsd.WithLabelValues(v.Slug).Set(vol24Sum)
	pmVenueVolume30dUsd.WithLabelValues(v.Slug).Set(vol30Sum)
	// Gamma's openInterest is deprecated and returns 0 across the board;
	// skip the Set when it is zero so the DefiLlama loop's TVL-as-OI
	// fallback can populate the gauge without being clobbered here.
	if oiSum > 0 {
		pmVenueOpenInterestUsd.WithLabelValues(v.Slug).Set(oiSum)
	}
	pmVenueActiveMarkets.WithLabelValues(v.Slug).Set(activeCount)
	pmVenueTopMarketVolume24hUsd.WithLabelValues(v.Slug).Set(topVol24)
	pmVenueMarketsAbove1m.WithLabelValues(v.Slug).Set(above1mCount)

	pmCohortStatsLastRefresh.WithLabelValues(v.Slug, "polymarket").Set(float64(time.Now().Unix()))
	pmCohortStatsLastTickUnix.Set(float64(time.Now().Unix()))

	fmt.Printf("[polymarket][%s] pages=%d active=%.0f vol24h=%.0f vol30d=%.0f oi=%.0f top24h=%.0f above1m=%.0f\n",
		v.Slug, pagesOK, activeCount, vol24Sum, vol30Sum, oiSum, topVol24, above1mCount)
}

// getJSON is a tiny wrapper around the HTTP GET that returns the body bytes
// or a classified error string. The classifier on the metrics side reads
// substrings like "timeout", "429", "5xx"; we surface those in the error
// message so the bucket lands correctly.
func getJSON(client *http.Client, url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", polymarketUA)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
