package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// MobulaPairsSource hits the Mobula perp pairs catalog:
//
//	GET https://api.mobula.io/api/2/perp/pairs
//
// One call returns the full catalog across every dex Mobula tracks
// today (Lighter, Gains, plus Mobula-side test fixtures). We bucket
// by `dex` field and emit `active_markets` per venue.
//
// Why this source: Mobula already curates the markets list for these
// two venues with `assetClass` tags (crypto, forex, stocks, commodities,
// indices, degen, new). Hitting Mobula once beats hitting each venue
// native API and avoids duplicating the asset-class taxonomy harness
// side.
type MobulaPairsSource struct {
	apiKey string
	client *http.Client
}

func NewMobulaPairsSource(apiKey string) *MobulaPairsSource {
	return &MobulaPairsSource{
		apiKey: apiKey,
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *MobulaPairsSource) Name() string { return srcMobulaPairs }

type mobulaPair struct {
	Dex        string `json:"dex"`
	Chain      string `json:"chain"`
	AssetClass string `json:"assetClass"`
}

type mobulaPairsResponse struct {
	Data []mobulaPair `json:"data"`
}

func (s *MobulaPairsSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	url := "https://api.mobula.io/api/2/perp/pairs"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return res, err
	}
	if s.apiKey != "" {
		req.Header.Set("Authorization", s.apiKey)
	}
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")

	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("all", srcMobulaPairs, classifyError(err.Error())).Inc()
		return res, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return res, err
	}
	if resp.StatusCode != 200 {
		perpCohortFetchErrors.WithLabelValues("all", srcMobulaPairs, fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return res, fmt.Errorf("mobula pairs http %d", resp.StatusCode)
	}

	var parsed mobulaPairsResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		perpCohortFetchErrors.WithLabelValues("all", srcMobulaPairs, "parse").Inc()
		return res, err
	}

	// Bucket by dex -> count. Mobula's dex tag uses lower-case venue
	// slugs that match the OCB harness convention (gains, lighter, ...).
	// We skip the testnet `arbitrum-sepolia` chain rows so the active
	// markets gauge reflects mainnet inventory only.
	counts := map[string]int{}
	for _, p := range parsed.Data {
		if p.Chain == "arbitrum-sepolia" {
			continue
		}
		counts[p.Dex]++
	}
	for dex, n := range counts {
		res.Set(dex, mActiveMarkets, float64(n))
	}
	fmt.Printf("[perp-cohort][mobula_pairs] ok: %d dexes, counts=%v\n", len(counts), counts)
	return res, nil
}
