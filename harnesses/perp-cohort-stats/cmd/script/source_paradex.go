package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ParadexNativeSource hits two endpoints:
//
//	GET https://api.prod.paradex.trade/v1/markets                 (catalog)
//	GET https://api.prod.paradex.trade/v1/markets/summary?market=ALL  (per-market live)
//
// The catalog returns ~1.5k instruments (PERP + OPTION); we filter to
// asset_kind == "PERP". The summary call returns the same superset
// keyed by symbol; we keep rows whose symbol ends in `-USD-PERP`. The
// `total_volume` field is a lifetime number; the 24h field is
// `volume_24h`.
//
// Derived metrics:
//
//	volume_24h_usd            = sum(volume_24h) across perp markets
//	oi_usd                    = sum(open_interest * mark_price)
//	active_markets            = count(perp rows in summary that have a mark_price)
//	top_market_volume_24h_usd = max(volume_24h)
type ParadexNativeSource struct {
	client *http.Client
}

func NewParadexNativeSource() *ParadexNativeSource {
	return &ParadexNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *ParadexNativeSource) Name() string { return srcParadexNative }

type paradexSummaryRow struct {
	Symbol       string `json:"symbol"`
	MarkPrice    string `json:"mark_price"`
	OpenInterest string `json:"open_interest"`
	Volume24h    string `json:"volume_24h"`
}

type paradexSummaryResponse struct {
	Results []paradexSummaryRow `json:"results"`
}

// paradexCatalog is GET /markets: the static catalog carries the
// editorial `tags` (RWA, LAYER-1, DEFI, MEME, AI) the summary lacks.
type paradexCatalog struct {
	Results []struct {
		Symbol    string   `json:"symbol"`
		AssetKind string   `json:"asset_kind"`
		Tags      []string `json:"tags"`
	} `json:"results"`
}

// rwaTagged returns the set of perp symbols Paradex tags RWA. A failed
// catalog call returns nil and the tick publishes no breadth for the
// venue (the gauges keep their previous values).
func (s *ParadexNativeSource) rwaTagged() map[string]bool {
	body, err := s.get("https://api.prod.paradex.trade/v1/markets")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("paradex", srcParadexNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][paradex][%s] catalog err: %v\n", srcParadexNative, err)
		return nil
	}
	var cat paradexCatalog
	if err := json.Unmarshal(body, &cat); err != nil {
		perpCohortFetchErrors.WithLabelValues("paradex", srcParadexNative, "parse").Inc()
		return nil
	}
	rwa := map[string]bool{}
	for _, m := range cat.Results {
		for _, t := range m.Tags {
			if t == "RWA" {
				rwa[m.Symbol] = true
			}
		}
	}
	return rwa
}

func (s *ParadexNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "paradex"

	body, err := s.get("https://api.prod.paradex.trade/v1/markets/summary?market=ALL")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcParadexNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcParadexNative, err)
		return res, nil
	}

	var parsed paradexSummaryResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcParadexNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse: %v\n", venue, srcParadexNative, err)
		return res, nil
	}

	// Breadth: the venue's RWA tag decides non-crypto; the symbol tables
	// split that bucket into commodities (XAU, CL, NG), indices (US500,
	// US100) and stocks (the rest).
	rwa := s.rwaTagged()
	breadth := breadthCounter{}

	var volSum, oiSum, topVol float64
	var active int
	for _, m := range parsed.Results {
		// Symbol convention: `<BASE>-USD-PERP` for linear perps. Anything
		// with a date suffix (`-26JUN26-`) is an option and is skipped.
		if !strings.HasSuffix(m.Symbol, "-USD-PERP") {
			continue
		}
		mark, _ := strconv.ParseFloat(m.MarkPrice, 64)
		if mark <= 0 {
			continue
		}
		active++
		if rwa != nil {
			if rwa[m.Symbol] {
				breadth.add(rwaClass(baseSymbol(m.Symbol)))
			} else {
				breadth.add(classCrypto)
			}
		}
		v, _ := strconv.ParseFloat(m.Volume24h, 64)
		volSum += v
		if v > topVol {
			topVol = v
		}
		oi, _ := strconv.ParseFloat(m.OpenInterest, 64)
		oiSum += oi * mark
	}

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	res.SetBreadth(venue, breadth)
	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d vol24h=%.0f oi=%.0f top24h=%.0f breadth: %s\n",
		venue, srcParadexNative, active, volSum, oiSum, topVol, breadth)
	return res, nil
}

func (s *ParadexNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
	req.Header.Set("Accept", "application/json")
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
