package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"
)

// Limitless exposes a public unauthenticated REST API at api.limitless.exchange.
// It does NOT expose a per-market 24h or 30d volume field. The /markets/active
// payload only carries a CUMULATIVE `volume` (raw USDC base units, divide by
// collateralToken.decimals) and its formatted twin `volumeFormatted` (USD,
// native USDC so 1:1). To recover proper 24h / 30d notional we would need
// one of:
//
//   (a) Envio HyperIndex GraphQL reverse-engineering against the on-chain
//       conditional-token contracts on Base, summing trade events in a window.
//   (b) A persistent 1-minute /feed poller that maintains rolling state
//       across ticks and computes deltas (process-local; doesn't survive
//       restarts without a sidecar store).
//   (c) DefiLlama's 24h derivative metric for the Limitless protocol, when
//       it stabilises (today it under-reports vs on-chain).
//
// All three are out of scope for the MVP. This file ships only what the
// public REST cleanly supports:
//
//   pm_venue_active_markets{venue=limitless}
//       Authoritative. totalMarketsCount from /markets/active page 1.
//
//   pm_venue_top_market_volume_24h_usd{venue=limitless}
//       LIFETIME PROXY. max(volumeFormatted) across all active USDC markets.
//       The metric Help text is updated to disclose the proxy nature.
//
//   pm_venue_markets_above_1m{venue=limitless}
//       LIFETIME PROXY. count where volumeFormatted >= 1_000_000.
//       Same disclosure.
//
// pm_venue_volume_24h_usd and pm_venue_volume_30d_usd are deliberately NOT
// touched: Prometheus carries the previous-tick value forward (or remains
// absent if never set), which is the honest signal until one of (a/b/c)
// lands. pm_venue_open_interest_usd for Limitless STAYS on DefiLlama TVL
// (see defillama.go); we do not write OI from here.
//
// Per CLAUDE.md MVP rule: zero speculative features. If a structural gap
// can't be filled honestly, surface the gap, don't paper it over.

const (
	limitlessBase     = "https://api.limitless.exchange"
	limitlessPageSize = 25 // server-side hard cap; limit > 25 is silently clamped.
	limitlessUA       = "OCB-pm-cohort-stats/1.0"
	// Politeness budget. Limitless does not advertise x-ratelimit-* headers
	// and there's no documented hard cap; the host is Cloudflare-fronted.
	// 200 ms between page fetches is well under any sane CDN ceiling and
	// keeps a full walk of ~10 pages under ~2 s.
	limitlessInterPageDelay = 200 * time.Millisecond
	// Hard safety cap on pages per tick. At pageSize=25, 200 pages covers
	// 5000 active markets; the live count is well under 1000 today.
	limitlessMaxPages = 200
)

var httpClientLimitless = &http.Client{Timeout: 20 * time.Second}

// limitlessMarket mirrors the subset of /markets/active row fields we read.
// `volume` is a stringified raw USDC base-unit count; `volumeFormatted` is
// a stringified USD figure (native USDC, 1:1). Status FUNDED + null
// winningOutcomeIndex = open. We filter to USDC collateral only.
type limitlessMarket struct {
	Volume           string `json:"volume"`
	VolumeFormatted  string `json:"volumeFormatted"`
	Status           string `json:"status"`
	WinningOutcome   *int   `json:"winningOutcomeIndex"`
	CollateralToken  struct {
		Symbol   string `json:"symbol"`
		Decimals int    `json:"decimals"`
	} `json:"collateralToken"`
}

type limitlessActiveResp struct {
	Data              []limitlessMarket `json:"data"`
	TotalMarketsCount int               `json:"totalMarketsCount"`
}

func fetchAllLimitless() {
	v := VenueBySlug("limitless")
	if v == nil {
		return
	}
	go fetchLimitlessVenue(*v)
}

func fetchLimitlessVenue(v Venue) {
	start := time.Now()
	defer func() {
		pmCohortStatsFetchLatencyMs.WithLabelValues(v.Slug, "limitless").Set(float64(time.Since(start).Milliseconds()))
	}()

	// Page 1 doubles as the totalMarketsCount probe so we know how many
	// pages to walk.
	first, err := limitlessFetchPage(1)
	if err != nil {
		pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "limitless", classifyError(err.Error())).Inc()
		fmt.Printf("[limitless][%s] page=1 error: %v\n", v.Slug, err)
		return
	}

	pmVenueActiveMarkets.WithLabelValues(v.Slug).Set(float64(first.TotalMarketsCount))

	var (
		maxVol        float64
		above1mCount  float64
		pagesWalked   = 1
		rowsConsidered int
	)
	process := func(rows []limitlessMarket) {
		for _, m := range rows {
			if m.CollateralToken.Symbol != "USDC" {
				continue
			}
			vf, err := strconv.ParseFloat(m.VolumeFormatted, 64)
			if err != nil || math.IsNaN(vf) || math.IsInf(vf, 0) {
				continue
			}
			rowsConsidered++
			if vf > maxVol {
				maxVol = vf
			}
			if vf >= 1_000_000 {
				above1mCount++
			}
		}
	}
	process(first.Data)

	// totalMarketsCount / 25 rounded up = total pages. We already have page 1.
	totalPages := (first.TotalMarketsCount + limitlessPageSize - 1) / limitlessPageSize
	if totalPages > limitlessMaxPages {
		totalPages = limitlessMaxPages
	}
	for page := 2; page <= totalPages; page++ {
		time.Sleep(limitlessInterPageDelay)
		r, err := limitlessFetchPage(page)
		if err != nil {
			pmCohortStatsFetchErrors.WithLabelValues(v.Slug, "limitless", classifyError(err.Error())).Inc()
			fmt.Printf("[limitless][%s] page=%d error: %v\n", v.Slug, page, err)
			break
		}
		if len(r.Data) == 0 {
			break
		}
		process(r.Data)
		pagesWalked++
	}

	// Lifetime proxies: publish unconditionally so the gauge reflects
	// today's snapshot, even when zero (a brand-new restart shouldn't
	// inherit a stale Polymarket-style carry-forward from a prior bug).
	pmVenueTopMarketVolume24hUsd.WithLabelValues(v.Slug).Set(maxVol)
	pmVenueMarketsAbove1m.WithLabelValues(v.Slug).Set(above1mCount)

	pmCohortStatsLastRefresh.WithLabelValues(v.Slug, "limitless").Set(float64(time.Now().Unix()))
	pmCohortStatsLastTickUnix.Set(float64(time.Now().Unix()))

	fmt.Printf("[limitless][%s] active=%d pages=%d/%d usdc_rows=%d top_lifetime=%.0f above1m_lifetime=%.0f\n",
		v.Slug, first.TotalMarketsCount, pagesWalked, totalPages, rowsConsidered, maxVol, above1mCount)
}

// limitlessFetchPage hits /markets/active?page=N&limit=25&sortBy=newest.
// `newest` is the only sortBy that validates today; other values 400.
func limitlessFetchPage(page int) (*limitlessActiveResp, error) {
	url := fmt.Sprintf("%s/markets/active?page=%d&limit=%d&sortBy=newest", limitlessBase, page, limitlessPageSize)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", limitlessUA)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClientLimitless.Do(req)
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
	var r limitlessActiveResp
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	return &r, nil
}
