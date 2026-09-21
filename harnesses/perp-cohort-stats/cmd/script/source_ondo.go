package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// OndoNativeSource reads Ondo Perps (ondoperps.xyz, live since 2026-06-09):
// an off-chain matching engine in an SGX enclave with on-chain custody on
// Ethereum and Arbitrum, USDC and tokenized stocks as collateral, 65 active
// markets of which 56 are stocks, ETFs, commodities, indices and FX.
//
//	GET https://api.ondoperps.xyz/v1/perps/contracts   (one call, every market)
//
// Each row carries usdVolume (24h), openInterestUsd, fundingRate (hourly),
// bid/ask, maker/taker fee. Derived metrics:
//
//	volume_24h_usd            = sum(usdVolume) over enabled perpetual markets
//	oi_usd                    = sum(openInterestUsd)
//	active_markets            = count(enabled markets)
//	top_market_volume_24h_usd = max(usdVolume)
//	funding (BTC, ETH, SOL)   = fundingRate x 24 x 10000 bps per day, 1 h interval
//
// No fees_30d or TVL: the API has no fee history and the venue's collateral
// is not a TVL in the DefiLlama sense (per-account deposit addresses swept
// to a hot wallet).
type OndoNativeSource struct {
	client *http.Client
}

func NewOndoNativeSource() *OndoNativeSource {
	return &OndoNativeSource{client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *OndoNativeSource) Name() string { return srcOndoNative }

type ondoContract struct {
	Market          string   `json:"market"`
	ProductType     string   `json:"productType"`
	BaseCurrency    string   `json:"baseCurrency"`
	Disabled        bool     `json:"disabled"`
	IsClosed        bool     `json:"isClosed"`
	UsdVolume       string   `json:"usdVolume"`
	OpenInterestUsd string   `json:"openInterestUsd"`
	FundingRate     string   `json:"fundingRate"`
	Tags            []string `json:"tags"`
}

type ondoContractsResponse struct {
	Success bool           `json:"success"`
	Result  []ondoContract `json:"result"`
}

func (s *OndoNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "ondo"
	body, err := s.get("https://api.ondoperps.xyz/v1/perps/contracts")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcOndoNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcOndoNative, err)
		return res, nil
	}
	var parsed ondoContractsResponse
	if err := json.Unmarshal(body, &parsed); err != nil || !parsed.Success {
		perpCohortFetchErrors.WithLabelValues(venue, srcOndoNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse: %v success=%v\n", venue, srcOndoNative, err, parsed.Success)
		return res, nil
	}

	var volSum, oiSum, topVol float64
	var active, nonCrypto int
	for _, c := range parsed.Result {
		if c.Disabled || c.ProductType != "perpetual" {
			continue
		}
		active++
		crypto := false
		for _, t := range c.Tags {
			if t == "Crypto" {
				crypto = true
			}
		}
		if !crypto {
			nonCrypto++
		}
		v, _ := strconv.ParseFloat(c.UsdVolume, 64)
		volSum += v
		if v > topVol {
			topVol = v
		}
		oi, _ := strconv.ParseFloat(c.OpenInterestUsd, 64)
		oiSum += oi
		switch c.BaseCurrency {
		case "BTC", "ETH", "SOL":
			if rate, err := strconv.ParseFloat(c.FundingRate, 64); err == nil {
				// Hourly funding (docs: "Funding Rates", hourly mechanism).
				res.SetFunding(venue, c.BaseCurrency, fundingPoint{Bps24h: rate * 24 * 10000, IntervalHours: 1})
			}
		}
	}

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d (non-crypto %d) vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcOndoNative, active, nonCrypto, volSum, oiSum, topVol)
	return res, nil
}

func (s *OndoNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http_%d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 8<<20))
}
