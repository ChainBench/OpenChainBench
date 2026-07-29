package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Myriad publishes a public, unauthenticated v2 REST API that lists every
// market the venue ever had. We aggregate per-tick to produce the full
// pm_venue_* cohort gauges, mirroring the polymarket.go shape.
//
// Endpoint contract (https://api-v2.myriadprotocol.com):
//
//	GET /markets?state=<open|resolved>&sort=<volume_notional|volume_notional_24h|expires_at>&limit=100&page=N
//
// Response:
//
//	{
//	  "data": [
//	    {
//	      "slug": "...",
//	      "volume": 12345.6,             // all-time, in token units
//	      "volume24h": 100,              // 24h, in token units
//	      "volumeNotional": 12345.6,     // all-time, in token notional (USD if stable)
//	      "volumeNotional24h": 100,      // 24h, in token notional
//	      "liquidity": 4000,             // pool liquidity in token units
//	      "liquidityPrice": 1.0,         // token price used to derive USD
//	      "token": {"symbol": "USDC", "address": "0x...", "decimals": 6},
//	      "state": "open",
//	      "publishedAt": "2026-...",
//	      "expiresAt": "2026-...",
//	      "resolvesAt": null
//	    }
//	  ],
//	  "pagination": {"page": 1, "limit": 100, "total": 99, "totalPages": 1, "hasNext": false}
//	}
//
// CRITICAL FILTER: skip rows where token.symbol == "PTS". PTS = Myriad
// Points, an off-chain non-monetary loyalty token. Counting it as USD
// would massively inflate the USD-denominated gauges (live cohort split
// today: 99 open markets, 67 USD-stable, 32 PTS).
//
// USD anchors: USDC, USDT, USD1, USDC.e, USD Tether ("USD₮") are treated
// 1:1. Anything else (after PTS exclusion) is skipped from USD sums but
// still counted nowhere — we only count USD-stable rows in the gauges
// since the leaderboard is denominated in USD.
//
// Rate budget: ~8 requests per tick:
//   1 sweep of /markets?state=open paginated (1-2 pages)
//   1 sweep of /markets?state=resolved&sort=expires_at (just-resolved markets)
//   1 sweep of /markets?state=resolved&sort=volume_notional paginated
//     (broken early once the first row drops below $1M; today this is 1-2 pages)
// At 30 req/10s public budget we self-throttle to 1 req/s.

const (
	myriadBase      = "https://api-v2.myriadprotocol.com"
	myriadUA        = "OCB-pm-cohort-stats/1.0"
	myriadLimit     = 100
	myriadMaxPages  = 50 // hard safety cap; live `total` is well under 5k today
	myriadReqDelay  = 1 * time.Second
	myriad1mFloor   = 1_000_000.0
	myriadResolved24hCushion = 24 * time.Hour
)

// myriadUsdStableSymbols is the allow-list of token symbols we treat as
// USD-equivalent. Comparison is case-insensitive and "USD₮" is the Tether
// pretty-print symbol Myriad exposes for USDT on some chains.
var myriadUsdStableSymbols = map[string]struct{}{
	"USDC":   {},
	"USDT":   {},
	"USD1":   {},
	"USDC.E": {},
	"USD₮":   {},
}

var httpClientMyriad = &http.Client{Timeout: 20 * time.Second}

type myriadToken struct {
	Symbol   string `json:"symbol"`
	Address  string `json:"address"`
	Decimals int    `json:"decimals"`
}

type myriadMarket struct {
	Slug              string      `json:"slug"`
	Volume            flexFloat   `json:"volume"`
	Volume24h         flexFloat   `json:"volume24h"`
	VolumeNotional    flexFloat   `json:"volumeNotional"`
	VolumeNotional24h flexFloat   `json:"volumeNotional24h"`
	Liquidity         flexFloat   `json:"liquidity"`
	LiquidityPrice    flexFloat   `json:"liquidityPrice"`
	Token             myriadToken `json:"token"`
	State             string      `json:"state"`
	PublishedAt       string      `json:"publishedAt"`
	ExpiresAt         string      `json:"expiresAt"`
}

type myriadPagination struct {
	Page       int  `json:"page"`
	Limit      int  `json:"limit"`
	Total      int  `json:"total"`
	TotalPages int  `json:"totalPages"`
	HasNext    bool `json:"hasNext"`
	HasPrev    bool `json:"hasPrev"`
}

type myriadResp struct {
	Data       []myriadMarket   `json:"data"`
	Pagination myriadPagination `json:"pagination"`
}

func fetchAllMyriad() {
	v := VenueBySlug("myriad")
	if v == nil {
		return
	}
	go fetchMyriadVenue(*v)
}

func fetchMyriadVenue(v Venue) {
	start := time.Now()
	defer func() {
		pmCohortStatsFetchLatencyMs.WithLabelValues(v.Slug, "myriad").Set(float64(time.Since(start).Milliseconds()))
	}()

	// --- Track A: open markets, sorted by lifetime volume_notional.
	// Myriad's API occasionally returns 500 on this sort; fall back to
	// volume_notional_24h and then to no sort before giving up.
	openRows, ok := myriadFetchAll(v, "open", "volume_notional")
	if !ok {
		time.Sleep(2 * time.Second)
		openRows, ok = myriadFetchAll(v, "open", "volume_notional_24h")
	}
	if !ok {
		return
	}

	var (
		vol24Sum    float64
		oiSum       float64
		activeCount float64
		topVol24    float64
	)

	now := time.Now()

	// First page is sorted desc by volume_notional, so the first USD-stable
	// row is the top by lifetime notional. For the 24h-top gauge we still
	// scan the cohort: a market can have huge lifetime volume but be quiet
	// the last 24h, and vice versa. Single pass, O(n).
	for _, r := range openRows {
		if !myriadIsUsdStable(r.Token.Symbol) {
			continue
		}
		v24 := float64(r.VolumeNotional24h)
		liq := float64(r.Liquidity) * float64(r.LiquidityPrice)
		if liq <= 0 {
			liq = float64(r.Liquidity) // fall back to raw amount when price is zero/missing
		}

		vol24Sum += v24
		oiSum += liq
		activeCount++
		if v24 > topVol24 {
			topVol24 = v24
		}
	}

	// --- Track B: just-resolved markets, to catch 24h volume that already
	// left the open set. Sorted by expires_at desc, single sweep; we stop
	// as soon as we cross the now-24h cutoff.
	resolved24hCutoff := now.Add(-myriadResolved24hCushion)
	resolvedRecent, ok := myriadFetchRecentResolved(v, resolved24hCutoff)
	if ok {
		for _, r := range resolvedRecent {
			if !myriadIsUsdStable(r.Token.Symbol) {
				continue
			}
			vol24Sum += float64(r.VolumeNotional24h)
		}
	}

	// --- Track C: count markets that ever crossed $1M lifetime notional.
	// Sorted desc by volume_notional, break the moment the first row of a
	// page drops below the floor (or we run out of rows).
	above1mCount := myriadCountAbove1m(v)

	// 30d projection: vol24h * 30. Same convention as Kalshi's vol30d_proj
	// because the Myriad public API does not expose a rolling 30d field
	// and the publishedAt-based heuristic dropped to ~$0 (most active
	// markets were published > 30d ago, so their lifetime volume fell
	// outside the window). Help text on the gauge documents the projection.
	vol30Proj := vol24Sum * 30

	pmVenueVolume24hUsd.WithLabelValues(v.Slug).Set(vol24Sum)
	pmVenueVolume30dUsd.WithLabelValues(v.Slug).Set(vol30Proj)
	pmVenueOpenInterestUsd.WithLabelValues(v.Slug).Set(oiSum)
	pmVenueActiveMarkets.WithLabelValues(v.Slug).Set(activeCount)
	pmVenueTopMarketVolume24hUsd.WithLabelValues(v.Slug).Set(topVol24)
	pmVenueMarketsAbove1m.WithLabelValues(v.Slug).Set(above1mCount)

	pmCohortStatsLastRefresh.WithLabelValues(v.Slug, "myriad").Set(float64(time.Now().Unix()))
	pmCohortStatsLastTickUnix.Set(float64(time.Now().Unix()))

	fmt.Printf("[myriad][%s] active=%.0f vol24h=%.0f vol30d_proj=%.0f oi=%.0f top24h=%.0f above1m=%.0f\n",
		v.Slug, activeCount, vol24Sum, vol30Proj, oiSum, topVol24, above1mCount)
}

// myriadIsUsdStable returns true when the token symbol matches one of the
// known USD-anchored tokens. PTS rows are filtered here implicitly because
// "PTS" is absent from the allow-list.
func myriadIsUsdStable(symbol string) bool {
	if symbol == "" {
		return false
	}
	if _, ok := myriadUsdStableSymbols[strings.ToUpper(symbol)]; ok {
		return true
	}
	// "USD₮" includes a non-ASCII rune; strings.ToUpper does not change it
	// so the lookup above already covers it via the map key. Keep this
	// branch only as documentation of why we don't also normalize the
	// non-ASCII suffix.
	return false
}

// myriadFetchAll walks /markets?state=<state>&sort=<sort> until
// pagination.hasNext is false (or the safety cap kicks in). Returns the
// concatenated data slice. ok=false means we should NOT publish anything;
// errors are already bucketed.
func myriadFetchAll(v Venue, state, sort string) (rows []myriadMarket, ok bool) {
	for page := 1; page <= myriadMaxPages; page++ {
		url := fmt.Sprintf("%s/markets?state=%s&sort=%s&limit=%d&page=%d",
			myriadBase, state, sort, myriadLimit, page)
		body, err := getJSONMyriad(httpClientMyriad, url)
		if err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "myriad", classifyError(err.Error())).Inc()
			fmt.Printf("[myriad][%s] state=%s sort=%s page=%d error: %v\n", v.Slug, state, sort, page, err)
			// If we already have rows from previous pages, downgrade to a
			// partial publication rather than dropping the entire tick.
			return rows, len(rows) > 0
		}
		var r myriadResp
		if err := json.Unmarshal(body, &r); err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "myriad", "parse").Inc()
			return rows, len(rows) > 0
		}
		if len(r.Data) == 0 {
			break
		}
		rows = append(rows, r.Data...)
		if !r.Pagination.HasNext {
			break
		}
		time.Sleep(myriadReqDelay)
	}
	return rows, true
}

// myriadFetchRecentResolved walks /markets?state=resolved&sort=expires_at
// (desc) and stops as soon as a row's expiresAt falls before the cutoff.
// Tolerant of missing/unparseable expiresAt — we skip such rows.
func myriadFetchRecentResolved(v Venue, cutoff time.Time) (rows []myriadMarket, ok bool) {
	for page := 1; page <= myriadMaxPages; page++ {
		url := fmt.Sprintf("%s/markets?state=resolved&sort=expires_at&limit=%d&page=%d",
			myriadBase, myriadLimit, page)
		body, err := getJSONMyriad(httpClientMyriad, url)
		if err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "myriad", classifyError(err.Error())).Inc()
			fmt.Printf("[myriad][%s] resolved-recent page=%d error: %v\n", v.Slug, page, err)
			return rows, len(rows) > 0
		}
		var r myriadResp
		if err := json.Unmarshal(body, &r); err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "myriad", "parse").Inc()
			return rows, len(rows) > 0
		}
		if len(r.Data) == 0 {
			break
		}
		stop := false
		for _, m := range r.Data {
			t, err := time.Parse(time.RFC3339, m.ExpiresAt)
			if err != nil {
				continue
			}
			if t.Before(cutoff) {
				stop = true
				break
			}
			rows = append(rows, m)
		}
		if stop || !r.Pagination.HasNext {
			break
		}
		time.Sleep(myriadReqDelay)
	}
	return rows, true
}

// myriadCountAbove1m walks /markets?state=resolved&sort=volume_notional
// (desc) and counts USD-stable rows whose lifetime volumeNotional >= $1M.
// Stops the moment a page's first row drops below the floor.
func myriadCountAbove1m(v Venue) float64 {
	var count float64
	for page := 1; page <= myriadMaxPages; page++ {
		url := fmt.Sprintf("%s/markets?state=resolved&sort=volume_notional&limit=%d&page=%d",
			myriadBase, myriadLimit, page)
		body, err := getJSONMyriad(httpClientMyriad, url)
		if err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "myriad", classifyError(err.Error())).Inc()
			fmt.Printf("[myriad][%s] above1m page=%d error: %v\n", v.Slug, page, err)
			return count
		}
		var r myriadResp
		if err := json.Unmarshal(body, &r); err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "myriad", "parse").Inc()
			return count
		}
		if len(r.Data) == 0 {
			break
		}
		// Find first USD-stable row on the page to decide whether to keep
		// going. PTS rows could come first if sort tie-breaks happen to
		// stack them; skip them when probing the threshold.
		var firstNotional float64
		for _, m := range r.Data {
			if !myriadIsUsdStable(m.Token.Symbol) {
				continue
			}
			firstNotional = float64(m.VolumeNotional)
			break
		}
		if firstNotional > 0 && firstNotional < myriad1mFloor {
			break
		}
		for _, m := range r.Data {
			if !myriadIsUsdStable(m.Token.Symbol) {
				continue
			}
			if float64(m.VolumeNotional) >= myriad1mFloor {
				count++
			}
		}
		if !r.Pagination.HasNext {
			break
		}
		time.Sleep(myriadReqDelay)
	}
	return count
}

// getJSONMyriad mirrors getJSONDefillama so each fetcher owns its UA and
// the network paths stay isolated for debug.
func getJSONMyriad(client *http.Client, urlStr string) ([]byte, error) {
	req, _ := http.NewRequest("GET", urlStr, nil)
	req.Header.Set("User-Agent", myriadUA)
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
