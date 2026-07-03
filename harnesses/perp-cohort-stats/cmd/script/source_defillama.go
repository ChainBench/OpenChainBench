package main

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

// DefiLlamaScrapeSource pulls cohort numbers off the public protocol
// HTML pages at https://defillama.com/protocol/<slug>. The free JSON
// summary endpoints (/summary/derivatives/<slug>, /summary/dexs/<slug>)
// now return 402 (paid plan) so HTML scraping is the only public path
// for perp volume + OI without an API subscription.
//
// The protocol HTML pages embed Next.js page-data as inline JSON. Each
// page contains structured blocks keyed by metric category:
//
//	"perpVolume":{ "total24h":..., "total30d":... }
//	"openInterest":{ "total24h":..., "total30d":... }
//	"fees":{ "total24h":..., "total30d":... }
//
// We use a brace-matching extractor to pull the full nested block for
// each category, then scan for total24h / total30d. The pattern is
// stable across the 3 v1 venues; if DefiLlama changes its embed schema
// this source goes "unavailable" for that page and the router falls
// back to native sources (HL/Lighter) for the metrics they cover.
type DefiLlamaScrapeSource struct {
	client *http.Client
}

func NewDefillamaScrapeSource() *DefiLlamaScrapeSource {
	return &DefiLlamaScrapeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *DefiLlamaScrapeSource) Name() string { return srcDefillama }

// slugMap maps OCB venue slugs to DefiLlama protocol page slugs.
// Verified live against https://defillama.com/protocol/<slug>:
//   - hyperliquid       -> /protocol/hyperliquid          (200 OK)
//   - lighter           -> /protocol/lighter              (200 OK)
//   - gmx-v2            -> /protocol/gmx-v2-perps         (200 OK)
//   - gains             -> /protocol/gains-network        (200 OK)
//   - dydx              -> /protocol/dydx-v4              (200 OK, perpVolume present)
//   - paradex           -> /protocol/paradex              (200 OK, perpVolume present)
//   - aster             -> /protocol/aster                (200 OK, perpVolume present)
//   - edgex             -> /protocol/edgex-perps          (200 OK, perpVolume 24h=529M live)
//   - grvt              -> /protocol/grvt                 (200 OK, perpVolume present)
//
// Skipped: vertex (the /protocol/vertex-perps page has total24h=null
// today; native source is authoritative anyway). Re-add if DefiLlama
// resumes publishing daily numbers for the slug.
//
// Adding a venue: verify the page exists and returns the same embedded
// JSON blocks before adding the slug here.
var defillamaSlugMap = map[string]string{
	"hyperliquid": "hyperliquid",
	"lighter":     "lighter",
	"gmx-v2":      "gmx-v2-perps",
	"gains":       "gains-network",
	"dydx":        "dydx-v4",
	"paradex":     "paradex",
	"aster":       "aster",
	"edgex":       "edgex-perps",
	"grvt":        "grvt",
	// Sprint 3: added after the 2026-06 probe sweep. Live perpVolume
	// + openInterest verified on each page:
	//   - extended        -> /protocol/extended         (200 OK, vol24h live).
	//   - aevo            -> /protocol/aevo             (200 OK, vol24h live).
	//   - pacifica        -> /protocol/pacifica         (200 OK, vol24h live).
	//   - variational     -> /protocol/variational      (200 OK, vol24h live;
	//                                                    api.variational.io
	//                                                    is NXDOMAIN so this
	//                                                    page is the only path).
	//   - ostium          -> /protocol/ostium           (200 OK, vol24h live).
	// Drift is intentionally absent: its DefiLlama adapter reports
	// $0 and the venue is parked from the Registry pending the
	// Sprint 4 Solana RPC + Anchor IDL adapter.
	"extended":    "extended",
	"aevo":        "aevo",
	"pacifica":    "pacifica",
	"variational": "variational",
	"ostium":      "ostium",
}

func (s *DefiLlamaScrapeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	for venueSlug, llamaSlug := range defillamaSlugMap {
		if err := s.fetchVenue(venueSlug, llamaSlug, res); err != nil {
			perpCohortFetchErrors.WithLabelValues(venueSlug, srcDefillama, classifyError(err.Error())).Inc()
			fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venueSlug, srcDefillama, err)
			continue
		}
	}
	return res, nil
}

func (s *DefiLlamaScrapeSource) fetchVenue(venueSlug, llamaSlug string, res *SourceResult) error {
	url := fmt.Sprintf("https://defillama.com/protocol/%s", llamaSlug)
	html, err := s.get(url)
	if err != nil {
		return err
	}

	// Each block: {category}{nested-objects}{total24h,...,total30d,...}
	// Drift-style broken feeds publish $0 on the dashboard; treat any
	// extracted-but-zero perpVolume as "unavailable" so the source does
	// not falsely win the priority race.
	perpVol24, perpVol30, perpOK := extractTotals(html, "perpVolume")
	oi24, _, oiOK := extractTotals(html, "openInterest")
	_, fees30, feesOK := extractTotals(html, "fees")

	logParts := fmt.Sprintf("perp_ok=%v oi_ok=%v fees_ok=%v", perpOK, oiOK, feesOK)
	if perpOK && perpVol24 > 0 {
		res.Set(venueSlug, mVolume24h, perpVol24)
	}
	if perpOK && perpVol30 > 0 {
		res.Set(venueSlug, mVolume30d, perpVol30)
	}
	if oiOK && oi24 > 0 {
		res.Set(venueSlug, mOI, oi24)
	}
	if feesOK && fees30 > 0 {
		res.Set(venueSlug, mFees30d, fees30)
	}

	// If literally everything came back zero we treat the page as
	// unavailable so the router falls back to other sources cleanly.
	if !perpOK && !oiOK && !feesOK {
		return fmt.Errorf("unavailable: no blocks extracted from /%s", llamaSlug)
	}

	fmt.Printf("[perp-cohort][%s][%s] ok: %s vol24h=%.0f vol30d=%.0f oi=%.0f fees30d=%.0f\n",
		venueSlug, srcDefillama, logParts, perpVol24, perpVol30, oi24, fees30)
	return nil
}

func (s *DefiLlamaScrapeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	resp, err := s.client.Do(req)
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

// extractBlock returns the full JSON-object substring (including outer
// braces) for `"<key>":{...}` using brace counting. Handles arbitrary
// nesting depth and skips quoted braces. Returns "" if not found.
func extractBlock(html []byte, key string) string {
	needle := []byte(`"` + key + `":{`)
	idx := indexOf(html, needle)
	if idx < 0 {
		return ""
	}
	start := idx + len(needle) - 1 // points at the '{'
	depth := 0
	inStr := false
	escape := false
	for i := start; i < len(html); i++ {
		c := html[i]
		if escape {
			escape = false
			continue
		}
		if c == '\\' && inStr {
			escape = true
			continue
		}
		if c == '"' {
			inStr = !inStr
			continue
		}
		if inStr {
			continue
		}
		switch c {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return string(html[start : i+1])
			}
		}
	}
	return ""
}

var (
	reTotal24h = regexp.MustCompile(`"total24h":([0-9.]+)`)
	reTotal30d = regexp.MustCompile(`"total30d":([0-9.]+)`)
)

func extractTotals(html []byte, key string) (t24, t30 float64, ok bool) {
	blk := extractBlock(html, key)
	if blk == "" {
		return 0, 0, false
	}
	m24 := reTotal24h.FindStringSubmatch(blk)
	m30 := reTotal30d.FindStringSubmatch(blk)
	if m24 != nil {
		t24, _ = strconv.ParseFloat(m24[1], 64)
	}
	if m30 != nil {
		t30, _ = strconv.ParseFloat(m30[1], 64)
	}
	// Consider a block "ok" if it parsed at all (even all-zero values
	// from broken venues like Drift); the publisher above decides not
	// to overwrite the gauge when the value is zero.
	if m24 != nil || m30 != nil {
		return t24, t30, true
	}
	return 0, 0, false
}

// indexOf is a tiny byte-substring search; net/http already pulls in
// bytes, but a tight loop here avoids the import for one call.
func indexOf(hay, needle []byte) int {
	if len(needle) == 0 {
		return 0
	}
	n := len(hay) - len(needle)
	for i := 0; i <= n; i++ {
		match := true
		for j := 0; j < len(needle); j++ {
			if hay[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}
