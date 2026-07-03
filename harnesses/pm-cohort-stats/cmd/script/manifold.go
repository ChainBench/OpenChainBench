package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Manifold is a public, no-auth prediction market with its own REST
// surface at api.manifold.markets/v0. Rate limit is 500 req/min per IP
// (confirmed live). We walk /search-markets paginated through the open
// universe and add a single page of resolved markets to catch anything
// that resolved in the last 24h (and to count the historical $1M+ set).
//
// IMPORTANT STRUCTURAL NOTE: Manifold is PLAY-MONEY. The unit is "mana"
// and there is NO official mana->USD exchange rate. References available:
//
//	- Legacy charity donation rate: 1000 mana = $1 USD (still surfaces on
//	  the donation page; the only published number that ties mana to USD).
//	- Sweepstakes CASH token: $1 = 1 CASH directly, but the CASH surface
//	  on /search-markets is currently empty so it doesn't contribute.
//
// DECISION: we publish DUAL gauges. The mana-denominated family
// (pm_venue_*_mana) is the raw, source-of-truth number. The existing
// USD family (pm_venue_*_usd) is scaled by MANIFOLD_MANA_USD_RATE
// (default 0.001, the charity rate). Both sides carry explicit Help
// text on the metrics.go side disclosing that the conversion is a
// disclosed convention, not a market price.
//
// CASH-denominated rows, if any come back, are multiplied by 1.0 (since
// 1 CASH = $1 USD directly) so they aggregate cleanly into the USD-side
// without polluting the mana-side numerator.

const (
	manifoldBase     = "https://api.manifold.markets/v0"
	manifoldUA       = "OCB-pm-cohort-stats/1.0"
	manifoldPageSize = 1000
	// Safety cap: 5 pages * 1000 = 5k markets. Live open universe is
	// ~1.1k so this is 4x headroom; if the open set blows up past 5k
	// the loop terminates cleanly and the values are still useful.
	manifoldMaxOpenPages = 5
	// 1B mana threshold = $1M USD at the default 0.001 charity rate.
	manifoldOneBillionMana = 1_000_000_000.0
)

var httpClientManifold = &http.Client{Timeout: 30 * time.Second}

// manifoldMarket mirrors only the fields we consume from
// /v0/search-markets. Numbers are unboxed floats on this endpoint, so
// no flexFloat is needed.
type manifoldMarket struct {
	Volume          float64 `json:"volume"`
	Volume24Hours   float64 `json:"volume24Hours"`
	TotalLiquidity  float64 `json:"totalLiquidity"`
	Token           string  `json:"token"`
	IsResolved      bool    `json:"isResolved"`
	CloseTime       int64   `json:"closeTime"`
	ResolutionTime  int64   `json:"resolutionTime"`
}

func fetchAllManifold(rate float64) {
	v := VenueBySlug("manifold")
	if v == nil {
		return
	}
	go fetchManifoldVenue(*v, rate)
}

func fetchManifoldVenue(v Venue, rate float64) {
	start := time.Now()
	defer func() {
		pmCohortStatsFetchLatencyMs.WithLabelValues(v.Slug, "manifold").Set(float64(time.Since(start).Milliseconds()))
	}()

	var (
		vol24Sum     float64 // mana (CASH rows convert to mana-equivalent via 1/rate so the USD-side
		// stays coherent, but for clarity we keep mana-side accumulators pure mana and
		// add CASH contributions separately to the USD-side accumulators below).
		oiSum         float64 // mana, open markets only
		activeCount   float64
		topVol24      float64 // mana, max across all sweeps
		above1bMana   float64 // count where lifetime mana >= 1e9 (i.e. $1M at charity rate)

		// USD-side accumulators. For MANA rows: mana * rate. For CASH rows: value * 1.0.
		vol24SumUsd float64
		oiSumUsd    float64
		topVol24Usd float64
		above1mUsd  float64 // count where lifetime USD-equivalent >= $1M

		pagesOK int
	)

	consider := func(rows []manifoldMarket, includeInOI bool) {
		for _, m := range rows {
			isCash := m.Token == "CASH"
			// Per-row USD value scaler. For MANA rows: mana * rate.
			// For CASH rows: 1.0 (CASH = $1 directly).
			usdScale := rate
			if isCash {
				usdScale = 1.0
			}

			// 24h volume contribution. Both mana-side and USD-side capture
			// MANA rows; CASH rows ONLY contribute to USD-side (mana-side
			// is by definition pure mana).
			if !isCash {
				vol24Sum += m.Volume24Hours
				if m.Volume24Hours > topVol24 {
					topVol24 = m.Volume24Hours
				}
				if m.Volume >= manifoldOneBillionMana {
					above1bMana++
				}
			}
			vol24Usd := m.Volume24Hours * usdScale
			vol24SumUsd += vol24Usd
			if vol24Usd > topVol24Usd {
				topVol24Usd = vol24Usd
			}
			if m.Volume*usdScale >= 1_000_000 {
				above1mUsd++
			}

			// Open-interest proxy: AMM seed (totalLiquidity). Open markets
			// only, so the resolved sweep doesn't pollute the OI gauge.
			if includeInOI {
				if !isCash {
					oiSum += m.TotalLiquidity
				}
				oiSumUsd += m.TotalLiquidity * usdScale
				activeCount++
			}
		}
	}

	// Pass 1: open markets, sorted by 24h volume, paginate to the end.
	for page := 0; page < manifoldMaxOpenPages; page++ {
		offset := page * manifoldPageSize
		url := fmt.Sprintf("%s/search-markets?term=&filter=open&sort=24-hour-vol&limit=%d&offset=%d",
			manifoldBase, manifoldPageSize, offset)
		body, err := getJSONManifold(httpClientManifold, url)
		if err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "manifold", classifyError(err.Error())).Inc()
			fmt.Printf("[manifold][%s] open page=%d error: %v\n", v.Slug, page, err)
			break
		}
		var rows []manifoldMarket
		if err := json.Unmarshal(body, &rows); err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "manifold", "parse").Inc()
			fmt.Printf("[manifold][%s] open page=%d parse error: %v\n", v.Slug, page, err)
			break
		}
		if len(rows) == 0 {
			break
		}
		consider(rows, true)
		pagesOK++
		if len(rows) < manifoldPageSize {
			break
		}
	}

	// Pass 2: single page of recently resolved markets. Catches markets
	// that resolved in the last 24h (they would otherwise drop out of
	// the open sweep entirely) AND surfaces historical big winners so
	// the >= $1M counter doesn't undercount the universe.
	{
		url := fmt.Sprintf("%s/search-markets?term=&filter=resolved&sort=newest&limit=%d&offset=0",
			manifoldBase, manifoldPageSize)
		body, err := getJSONManifold(httpClientManifold, url)
		if err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "manifold", classifyError(err.Error())).Inc()
			fmt.Printf("[manifold][%s] resolved page error: %v\n", v.Slug, err)
		} else {
			var rows []manifoldMarket
			if err := json.Unmarshal(body, &rows); err != nil {
				pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "manifold", "parse").Inc()
				fmt.Printf("[manifold][%s] resolved parse error: %v\n", v.Slug, err)
			} else {
				consider(rows, false)
				pagesOK++
			}
		}
	}

	if pagesOK == 0 {
		pmCohortStatsLastTickUnix.Set(float64(time.Now().Unix()))
		return
	}

	// 30d projection: 24h * 30 is an UPPER BOUND under stable flow, not a
	// rolling sum. Mirrors the Kalshi convention and is documented in the
	// gauge Help text.
	vol30Sum := vol24Sum * 30
	vol30SumUsd := vol24SumUsd * 30

	// Publish mana-side gauges.
	pmVenueVolume24hMana.WithLabelValues(v.Slug).Set(vol24Sum)
	pmVenueVolume30dMana.WithLabelValues(v.Slug).Set(vol30Sum)
	pmVenueOpenInterestMana.WithLabelValues(v.Slug).Set(oiSum)
	pmVenueTopMarketVolume24hMana.WithLabelValues(v.Slug).Set(topVol24)
	pmVenueMarketsAbove1bMana.WithLabelValues(v.Slug).Set(above1bMana)

	// Publish USD-side gauges (charity-rate scaled, with CASH rows at $1).
	pmVenueVolume24hUsd.WithLabelValues(v.Slug).Set(vol24SumUsd)
	pmVenueVolume30dUsd.WithLabelValues(v.Slug).Set(vol30SumUsd)
	pmVenueOpenInterestUsd.WithLabelValues(v.Slug).Set(oiSumUsd)
	pmVenueActiveMarkets.WithLabelValues(v.Slug).Set(activeCount)
	pmVenueTopMarketVolume24hUsd.WithLabelValues(v.Slug).Set(topVol24Usd)
	pmVenueMarketsAbove1m.WithLabelValues(v.Slug).Set(above1mUsd)

	pmCohortStatsLastRefresh.WithLabelValues(v.Slug, "manifold").Set(float64(time.Now().Unix()))
	pmCohortStatsLastTickUnix.Set(float64(time.Now().Unix()))

	fmt.Printf("[manifold][%s] pages=%d active=%.0f vol24h_mana=%.0f vol24h_usd=%.2f oi_mana=%.0f oi_usd=%.2f top24h_mana=%.0f above1b_mana=%.0f above1m_usd=%.0f rate=%v\n",
		v.Slug, pagesOK, activeCount, vol24Sum, vol24SumUsd, oiSum, oiSumUsd, topVol24, above1bMana, above1mUsd, rate)
}

// getJSONManifold is a dedicated client wrapper so we can carry our own
// UA and isolate the network path for debug, matching the per-source
// convention in polymarket.go / defillama.go / kalshi.go.
func getJSONManifold(client *http.Client, urlStr string) ([]byte, error) {
	req, _ := http.NewRequest("GET", urlStr, nil)
	req.Header.Set("User-Agent", manifoldUA)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body := make([]byte, 0, 4096)
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			body = append(body, buf[:n]...)
		}
		if err != nil {
			break
		}
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}
