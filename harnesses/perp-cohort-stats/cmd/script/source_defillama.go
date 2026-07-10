package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DefiLlamaScrapeSource pulls cohort numbers from DefiLlama's free JSON
// overview endpoints (2 requests per sweep, all venues at once):
//
//	GET https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true
//	GET https://api.llama.fi/overview/open-interest?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true
//
// History of this source, because it keeps breaking in new ways:
//   - v1 used /summary/derivatives/<slug> JSON: went 402 (paid plan).
//   - v2 scraped the protocol HTML pages: Cloudflare bot-challenged them
//     to 403 in 2026-07, which nulled volume30d/fees30d for every venue
//     on /perps and dragged bench success to 67%.
//   - v3 (this) uses the overview endpoints that are still on the free
//     tier. Perp VOLUME (24h/30d) is paid-only now, so this source no
//     longer publishes mVolume24h/mVolume30d at all; the /perps hub
//     derives volume30d from our own perp_venue_volume_24h_usd history
//     instead, and per-venue native sources own vol24h.
//
// The struct name is kept so the router wiring stays untouched.
type DefiLlamaScrapeSource struct {
	client *http.Client
}

func NewDefillamaScrapeSource() *DefiLlamaScrapeSource {
	return &DefiLlamaScrapeSource{
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

func (s *DefiLlamaScrapeSource) Name() string { return srcDefillama }

// defillamaSlugMap maps OCB venue slugs to DefiLlama protocol slugs as
// they appear in the JSON overview endpoints (mostly `-perps` suffixed,
// unlike the old HTML page slugs). Verified live 2026-07-10 against
// /overview/open-interest. drift stays absent (parked venue, dead
// adapter); vertex is intentionally excluded: its llama adapter reports
// null totals and the native archive source is authoritative.
var defillamaSlugMap = map[string]string{
	"hyperliquid": "hyperliquid-perps",
	"lighter":     "lighter-perps",
	"gmx-v2":      "gmx-v2-perps",
	"gains":       "gains-network",
	"dydx":        "dydx-v4",
	"paradex":     "paradex-perps",
	"aster":       "aster-perps",
	"edgex":       "edgex-perps",
	"grvt":        "grvt-perps",
	"extended":    "extended-perps",
	"aevo":        "aevo-perps",
	"pacifica":    "pacifica-perps",
	"variational": "variational",
	"ostium":      "ostium",
}

type llamaProto struct {
	Slug     string   `json:"slug"`
	Total24h *float64 `json:"total24h"`
	Total30d *float64 `json:"total30d"`
}

type llamaOverview struct {
	Protocols []llamaProto `json:"protocols"`
}

func (s *DefiLlamaScrapeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()

	fees, feesErr := s.overview("fees")
	oi, oiErr := s.overview("open-interest")
	if feesErr != nil && oiErr != nil {
		perpCohortFetchErrors.WithLabelValues("all", srcDefillama, classifyError(feesErr.Error())).Inc()
		fmt.Printf("[perp-cohort][all][%s] err: fees=%v oi=%v\n", srcDefillama, feesErr, oiErr)
		return res, nil
	}

	for venueSlug, llamaSlug := range defillamaSlugMap {
		var fees30, oiNow float64
		if fees != nil {
			if p := findProto(fees, llamaSlug); p != nil && p.Total30d != nil {
				fees30 = *p.Total30d
			}
		}
		if oi != nil {
			// open-interest overview: total24h holds the CURRENT OI in USD.
			if p := findProto(oi, llamaSlug); p != nil && p.Total24h != nil {
				oiNow = *p.Total24h
			}
		}
		if fees30 > 0 {
			res.Set(venueSlug, mFees30d, fees30)
		}
		if oiNow > 0 {
			res.Set(venueSlug, mOI, oiNow)
		}
		if fees30 > 0 || oiNow > 0 {
			fmt.Printf("[perp-cohort][%s][%s] ok: fees30d=%.0f oi=%.0f\n", venueSlug, srcDefillama, fees30, oiNow)
		}
	}
	return res, nil
}

func findProto(o *llamaOverview, slug string) *llamaProto {
	for i := range o.Protocols {
		if o.Protocols[i].Slug == slug {
			return &o.Protocols[i]
		}
	}
	return nil
}

func (s *DefiLlamaScrapeSource) overview(kind string) (*llamaOverview, error) {
	url := fmt.Sprintf("https://api.llama.fi/overview/%s?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true", kind)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 120))
	}
	var out llamaOverview
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	return &out, nil
}
