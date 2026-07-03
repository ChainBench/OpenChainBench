package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// MobulaFundingSource hits the Mobula CEFI funding-rate aggregator:
//
//	GET https://api.mobula.io/api/1/market/cefi/funding-rate?
//	      symbol=<asset>&exchange=<comma-separated venues>
//
// One call returns a JSON object with `<venue>FundingRate` keys (e.g.
// `hyperliquidFundingRate`, `lighterFundingRate`). Each entry has
// `fundingRate` (decimal per epoch) and `epochDurationMs` (epoch length
// in ms). We normalize to a 24h figure in basis points:
//
//	bps_24h = fundingRate * (86_400_000 / epochDurationMs) * 10_000
//
// We loop over the 3 OCB-anchor assets (BTC, ETH, SOL), so the per-tick
// cost is 3 requests * 12-venue fan-out per response = the full 12x3 grid.
type MobulaFundingSource struct {
	apiKey       string
	exchangeList string
	client       *http.Client
}

func NewMobulaFundingSource(apiKey, exchangeList string) *MobulaFundingSource {
	return &MobulaFundingSource{
		apiKey:       apiKey,
		exchangeList: exchangeList,
		client:       &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *MobulaFundingSource) Name() string { return srcMobulaFund }

// Mobula key naming: `<lowercase venue>FundingRate`. We map this back
// to the OCB perp slugs in venueFromMobulaKey. Only venues present in
// the priority map for funding are emitted; the rest of the grid is
// kept so the funding gauge cardinality covers the broader CEFI cohort
// the UI may render next to the perp DEX strip.
type mobulaFundingEntry struct {
	Symbol          string  `json:"symbol"`
	FundingRate     float64 `json:"fundingRate"`
	EpochDurationMs float64 `json:"epochDurationMs"`
	FundingTime     float64 `json:"fundingTime"`
}

func (s *MobulaFundingSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	assets := []string{"BTC", "ETH", "SOL"}
	for _, asset := range assets {
		if err := s.fetchOne(asset, res); err != nil {
			// Per-asset failures are bucketed under the funding source name;
			// we attribute to the "all-venues" carrier slug so the counter
			// stays meaningful without exploding cardinality.
			perpCohortFetchErrors.WithLabelValues("_all", srcMobulaFund, classifyError(err.Error())).Inc()
			fmt.Printf("[perp-cohort][_][%s] asset=%s err: %v\n", srcMobulaFund, asset, err)
			continue
		}
	}
	return res, nil
}

func (s *MobulaFundingSource) fetchOne(asset string, res *SourceResult) error {
	url := fmt.Sprintf("https://api.mobula.io/api/1/market/cefi/funding-rate?symbol=%s&exchange=%s",
		asset, s.exchangeList)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", s.apiKey)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	// The response is a flat object with `<venue>FundingRate` keys plus a
	// `queryDetails` sibling. We decode into a map and iterate.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return fmt.Errorf("parse: %w", err)
	}
	for key, v := range raw {
		if !strings.HasSuffix(key, "FundingRate") {
			continue
		}
		venueKey := strings.TrimSuffix(key, "FundingRate")
		var entry mobulaFundingEntry
		if err := json.Unmarshal(v, &entry); err != nil {
			continue
		}
		if entry.EpochDurationMs <= 0 {
			continue
		}
		bps24h := entry.FundingRate * (86_400_000.0 / entry.EpochDurationMs) * 10_000.0
		intervalHours := entry.EpochDurationMs / 3_600_000.0
		venueSlug := venueFromMobulaKey(venueKey)
		res.SetFunding(venueSlug, asset, fundingPoint{
			Bps24h:        bps24h,
			IntervalHours: intervalHours,
		})
	}
	fmt.Printf("[perp-cohort][_][%s] asset=%s ok: %d venues\n", srcMobulaFund, asset, len(res.Funding))
	return nil
}

// venueFromMobulaKey maps Mobula's lowercase venue key (e.g. "hyperliquid",
// "okx", "binance") to the OCB venue slug. The mapping is identity for
// most venues; the few exceptions are listed here so the funding gauge
// labels match the perp registry exactly when the venue is in cohort.
func venueFromMobulaKey(k string) string {
	switch k {
	case "hyperliquid":
		return "hyperliquid"
	case "lighter":
		return "lighter"
	default:
		// Pass-through for CEFI venues (binance, bybit, okx, ...). They
		// are not in the OCB perp DEX cohort today, but the funding
		// gauge surface includes them so adjacent UI panels (CEFI vs
		// DEX funding spread) can read straight from this harness.
		return k
	}
}
