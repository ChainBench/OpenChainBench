package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// DefiLlama is the fallback aggregate source for venues we have no
// dedicated public API for, plus a TVL-as-OI fallback for Polymarket
// (the gamma /markets openInterest field has been deprecated and
// returns 0 across the board; DefiLlama's protocol TVL is the closest
// public OI proxy). We hit the /protocols list once per tick, filter
// rows with category=="Prediction Market", and map by canonical name
// to each venue. The mapping is tolerant of casing and minor
// formatting variation.
//
// Myriad was previously fed by DefiLlama TVL (~$449k open-interest
// proxy), but now has a dedicated native fetcher (see myriad.go) whose
// gauges are authoritative; it is intentionally absent from llamaNames.
//
// DefiLlama publishes per-protocol fields we surface:
//   tvl                       -> pm_venue_open_interest_usd  (proxy: TVL is the closest public OI proxy for an on/off-chain PM)
//   volume_24h or change_1d   -> pm_venue_volume_24h_usd     (best effort; many PM protocols do not report)
//   volume_30d                -> pm_venue_volume_30d_usd     (best effort)
//
// active_markets, top_market_volume, markets_above_1m are NOT available
// from /protocols; those gauges are left untouched for these venues. The
// OCB page knows to render only the cards that have data.

const (
	defillamaBase    = "https://api.llama.fi"
	defillamaUA      = "OCB-pm-cohort-stats/1.0"
	defillamaPMCat   = "Prediction Market"
)

var httpClientDefillama = &http.Client{Timeout: 20 * time.Second}

// llamaNames maps an OCB venue slug to the canonical name DefiLlama uses
// in /protocols. Verified live by reading /protocols and matching the
// `name` field exactly. Manifold is intentionally omitted: as of today
// it is not listed under the Prediction Market category on DefiLlama,
// so the cohort gauges for Manifold stay empty until a dedicated public
// fetcher is added (Manifold has its own /v0/markets REST endpoint; out
// of scope for the first cut of this harness). Myriad is intentionally
// omitted now that the native /markets fetcher in myriad.go publishes
// authoritative gauges from the venue's own API.
var llamaNames = map[string]string{
	"limitless":  "Limitless Exchange",
	"polymarket": "Polymarket International",
}

type llamaProtocol struct {
	Name     string  `json:"name"`
	Category string  `json:"category"`
	TVL      float64 `json:"tvl"`
	Change1d float64 `json:"change_1d"`
}

func fetchAllDefillama() {
	// One shared list request per tick, then per-venue extraction in
	// parallel. The /protocols payload is ~2 MB and cached server-side,
	// so we deliberately avoid issuing one request per venue.
	start := time.Now()
	url := fmt.Sprintf("%s/protocols", defillamaBase)
	body, err := getJSONDefillama(httpClientDefillama, url)
	latency := float64(time.Since(start).Milliseconds())
	if err != nil {
		for slug := range llamaNames {
			pmCohortStatsFetchLatencyMs.WithLabelValues(slug, "defillama").Set(latency)
			pmCohortStatsFetchErrors.WithLabelValues(slug, "defillama", classifyError(err.Error())).Inc()
		}
		fmt.Printf("[defillama] list error: %v\n", err)
		return
	}

	var all []llamaProtocol
	if err := json.Unmarshal(body, &all); err != nil {
		for slug := range llamaNames {
			pmCohortStatsFetchLatencyMs.WithLabelValues(slug, "defillama").Set(latency)
			pmCohortStatsFetchErrors.WithLabelValues(slug, "defillama", "parse").Inc()
		}
		fmt.Printf("[defillama] list parse error: %v\n", err)
		return
	}

	// Index by normalized name across PM-category rows for fuzzy lookup.
	idx := map[string]llamaProtocol{}
	for _, p := range all {
		if p.Category != defillamaPMCat {
			continue
		}
		idx[normalizeName(p.Name)] = p
	}

	for slug, llamaName := range llamaNames {
		v := VenueBySlug(slug)
		if v == nil {
			continue
		}
		pmCohortStatsFetchLatencyMs.WithLabelValues(slug, "defillama").Set(latency)
		row, ok := idx[normalizeName(llamaName)]
		if !ok {
			pmCohortStatsFetchErrors.WithLabelValues(slug, "defillama", "not_tracked").Inc()
			fmt.Printf("[defillama][%s] not found in PM category (looked for %q)\n", slug, llamaName)
			continue
		}
		// TVL is the only consistently populated USD field; use it as the
		// open-interest proxy for these aggregate-only venues.
		if row.TVL > 0 {
			pmVenueOpenInterestUsd.WithLabelValues(slug).Set(row.TVL)
		}
		// /protocols does not expose volume; we leave volume gauges
		// untouched (Prom carry-forward keeps the last successful value
		// if a Polymarket-style fetcher ever publishes; otherwise the
		// gauge stays absent and the site renders only the cards we have).
		pmCohortStatsLastRefresh.WithLabelValues(slug, "defillama").Set(float64(time.Now().Unix()))
		fmt.Printf("[defillama][%s] tvl=%.0f change_1d=%.2f%%\n", slug, row.TVL, row.Change1d)
	}

	pmCohortStatsLastTickUnix.Set(float64(time.Now().Unix()))
}

// normalizeName lower-cases and strips spaces / punctuation so
// "Manifold Markets" and "manifold-markets" both index to the same key.
func normalizeName(s string) string {
	s = strings.ToLower(s)
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			out = append(out, c)
		}
	}
	return string(out)
}

// getJSONDefillama is a dedicated client variant so the Polymarket / Kalshi
// / DefiLlama fetchers can each set their own User-Agent header and keep
// the network paths isolated for debug.
func getJSONDefillama(client *http.Client, urlStr string) ([]byte, error) {
	req, _ := http.NewRequest("GET", urlStr, nil)
	req.Header.Set("User-Agent", defillamaUA)
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
