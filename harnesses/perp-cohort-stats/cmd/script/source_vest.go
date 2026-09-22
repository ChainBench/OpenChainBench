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

// VestNativeSource reads Vest (zk perp exchange, 544 listed markets of
// which about 90 trade at a time: crypto, US equities, indices, FX)
// from its public REST API:
//
//	GET https://server-prod.hz.vestmarkets.com/v2/ticker/24hr   (quoteVolume per symbol)
//	GET https://server-prod.hz.vestmarkets.com/v2/ticker/latest (status, markPrice, oneHrFundingRate)
//
// Symbol convention (docs.vest.exchange): crypto perps are `{COIN}-PERP`,
// equities, indices and FX are `{TICKER}-USD-PERP`. The API publishes
// no open interest, so the OI gauge stays unset for this venue.
// Funding is hourly (oneHrFundingRate), published as bps per 24 h hold.
//
// Derived metrics:
//
//	volume_24h_usd            = sum(quoteVolume) over /ticker/24hr rows
//	active_markets            = count(status == "TRADING") in /ticker/latest
//	top_market_volume_24h_usd = max(quoteVolume)
//	funding (BTC, ETH, SOL)   = oneHrFundingRate x 24 x 10000 bps per day, 1 h interval
type VestNativeSource struct {
	client *http.Client
}

func NewVestNativeSource() *VestNativeSource {
	return &VestNativeSource{client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *VestNativeSource) Name() string { return srcVestNative }

const vestBase = "https://server-prod.hz.vestmarkets.com/v2"

type vestTicker24h struct {
	Tickers []struct {
		Symbol      string `json:"symbol"`
		QuoteVolume string `json:"quoteVolume"`
	} `json:"tickers"`
}

type vestTickerLatest struct {
	Tickers []struct {
		Symbol           string `json:"symbol"`
		Status           string `json:"status"`
		OneHrFundingRate string `json:"oneHrFundingRate"`
	} `json:"tickers"`
}

// vestClass: `{COIN}-PERP` is a crypto perp, `{TICKER}-USD-PERP` an
// equity, index or FX perp split by the symbol tables (unknown tickers
// are equities, the venue lists no token under that convention).
func vestClass(symbol string) string {
	if strings.HasSuffix(symbol, "-USD-PERP") {
		return rwaClass(baseSymbol(symbol))
	}
	return classCrypto
}

func (s *VestNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "vest"

	body, err := s.get(vestBase + "/ticker/24hr")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcVestNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err 24hr: %v\n", venue, srcVestNative, err)
	} else {
		var t vestTicker24h
		if err := json.Unmarshal(body, &t); err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcVestNative, "parse").Inc()
		} else {
			var volSum, topVol float64
			for _, r := range t.Tickers {
				v, _ := strconv.ParseFloat(r.QuoteVolume, 64)
				volSum += v
				if v > topVol {
					topVol = v
				}
			}
			res.SetIfPositive(venue, mVolume24h, volSum)
			res.SetIfPositive(venue, mTopVol24h, topVol)
			fmt.Printf("[perp-cohort][%s][%s] ok 24hr: rows=%d vol24h=%.0f top24h=%.0f\n", venue, srcVestNative, len(t.Tickers), volSum, topVol)
		}
	}

	body, err = s.get(vestBase + "/ticker/latest")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcVestNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err latest: %v\n", venue, srcVestNative, err)
		return res, nil
	}
	var l vestTickerLatest
	if err := json.Unmarshal(body, &l); err != nil || len(l.Tickers) == 0 {
		perpCohortFetchErrors.WithLabelValues(venue, srcVestNative, "parse").Inc()
		return res, nil
	}
	var active int
	breadth := breadthCounter{}
	for _, r := range l.Tickers {
		if r.Status != "TRADING" {
			continue
		}
		active++
		class := vestClass(r.Symbol)
		breadth.add(class)
		if class == classCrypto {
			res.AddCryptoSymbol(baseSymbol(r.Symbol))
		} else {
			res.AddRWASymbol(baseSymbol(r.Symbol))
		}
		switch r.Symbol {
		case "BTC-PERP", "ETH-PERP", "SOL-PERP":
			if rate, err := strconv.ParseFloat(r.OneHrFundingRate, 64); err == nil {
				res.SetFunding(venue, strings.TrimSuffix(r.Symbol, "-PERP"), fundingPoint{Bps24h: rate * 24 * 10000, IntervalHours: 1})
			}
		}
	}
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	res.SetBreadth(venue, breadth)
	fmt.Printf("[perp-cohort][%s][%s] ok latest: active=%d breadth: %s\n", venue, srcVestNative, active, breadth)
	return res, nil
}

func (s *VestNativeSource) get(url string) ([]byte, error) {
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
