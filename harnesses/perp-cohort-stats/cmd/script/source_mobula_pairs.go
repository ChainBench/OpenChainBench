package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
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
	Name       string `json:"name"` // "BTC/USD"
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
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")

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
	byClass := map[string]map[string]int{} // dex -> class -> count
	for _, p := range parsed.Data {
		if p.Chain == "arbitrum-sepolia" {
			continue
		}
		counts[p.Dex]++
		if byClass[p.Dex] == nil {
			byClass[p.Dex] = map[string]int{}
		}
		byClass[p.Dex][p.AssetClass]++
		switch p.AssetClass {
		case classForex, classStocks, classIndices, classCommodities:
		default:
			// crypto, degen, new: a token market. The base is the part
			// before the slash ("BOT/USD" -> BOT); it feeds the cohort
			// known-crypto set used for the HIP-3 dexes (breadth.go).
			if i := strings.Index(p.Name, "/"); i > 0 {
				res.AddCryptoSymbol(baseSymbol(p.Name[:i]))
			}
		}
	}
	for dex, n := range counts {
		res.Set(dex, mActiveMarkets, float64(n))
	}

	// Mobula's degen (leverage variants of crypto pairs) and new
	// (listed, not yet classified) buckets are crypto for the breadth
	// gauges; the four non-crypto classes map one to one. See breadth.go.
	for dex, classes := range byClass {
		b := breadthCounter{}
		for class, n := range classes {
			switch class {
			case classForex, classStocks, classIndices, classCommodities:
				b[class] += n
			default:
				b[classCrypto] += n
			}
		}
		res.SetBreadth(dex, b)
	}

	fmt.Printf("[perp-cohort][mobula_pairs] ok: %d dexes, counts=%v\n", len(counts), counts)
	for dex, classes := range byClass {
		fmt.Printf("[perp-cohort][mobula_pairs] %s by class: %v\n", dex, classes)
	}
	return res, nil
}
