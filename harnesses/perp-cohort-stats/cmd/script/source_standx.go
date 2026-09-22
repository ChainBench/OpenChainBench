package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// StandXNativeSource reads StandX (DUSD-margined perp DEX on BNB Chain)
// from its one public overview call:
//
//	GET https://perps.standx.com/api/query_market_overview
//
// The summary block carries the venue totals (volume_quote_24h,
// open_interest_notional, symbol_count) and the symbols array one row
// per market with its own volume, OI and funding_rate (hourly, checked
// against query_funding_rates on 2026-09-22: one row per hour).
//
// Derived metrics:
//
//	volume_24h_usd            = summary.volume_quote_24h
//	oi_usd                    = summary.open_interest_notional
//	active_markets            = len(symbols)
//	top_market_volume_24h_usd = max(symbols[].volume_quote_24h)
//	funding (BTC, ETH, SOL)   = funding_rate x 24 x 10000 bps per day, 1 h interval
//
// The catalog mixes crypto with gold, silver, oil and a few equities
// without an asset class; the symbols go through the router's
// cross-venue classification (see breadth.go).
type StandXNativeSource struct {
	client *http.Client
}

func NewStandXNativeSource() *StandXNativeSource {
	return &StandXNativeSource{client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *StandXNativeSource) Name() string { return srcStandXNative }

type standxOverview struct {
	Summary struct {
		OpenInterestNotional string `json:"open_interest_notional"`
		SymbolCount          int    `json:"symbol_count"`
		VolumeQuote24h       string `json:"volume_quote_24h"`
	} `json:"summary"`
	Symbols []struct {
		Base           string `json:"base"`
		Symbol         string `json:"symbol"`
		FundingRate    string `json:"funding_rate"`
		VolumeQuote24h string `json:"volume_quote_24h"`
	} `json:"symbols"`
}

func (s *StandXNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "standx"

	body, err := s.get("https://perps.standx.com/api/query_market_overview")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcStandXNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcStandXNative, err)
		return res, nil
	}
	var o standxOverview
	if err := json.Unmarshal(body, &o); err != nil || len(o.Symbols) == 0 {
		perpCohortFetchErrors.WithLabelValues(venue, srcStandXNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse: %v (%d symbols)\n", venue, srcStandXNative, err, len(o.Symbols))
		return res, nil
	}

	vol, _ := strconv.ParseFloat(o.Summary.VolumeQuote24h, 64)
	oi, _ := strconv.ParseFloat(o.Summary.OpenInterestNotional, 64)
	var topVol float64
	syms := make([]string, 0, len(o.Symbols))
	for _, m := range o.Symbols {
		v, _ := strconv.ParseFloat(m.VolumeQuote24h, 64)
		if v > topVol {
			topVol = v
		}
		syms = append(syms, baseSymbol(m.Base))
		switch m.Base {
		case "BTC", "ETH", "SOL":
			if rate, err := strconv.ParseFloat(m.FundingRate, 64); err == nil {
				res.SetFunding(venue, m.Base, fundingPoint{Bps24h: rate * 24 * 10000, IntervalHours: 1})
			}
		}
	}
	res.SetIfPositive(venue, mVolume24h, vol)
	res.SetIfPositive(venue, mOI, oi)
	res.SetIfPositive(venue, mActiveMarkets, float64(len(o.Symbols)))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	res.SetUnclassified(venue, syms)
	fmt.Printf("[perp-cohort][%s][%s] ok: markets=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcStandXNative, len(o.Symbols), vol, oi, topVol)
	return res, nil
}

func (s *StandXNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; OpenChainBench-PerpCohort/1.0; contact@openchainbench.com)")
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
