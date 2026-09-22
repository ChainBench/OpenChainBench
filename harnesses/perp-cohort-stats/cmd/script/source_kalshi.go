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

// KalshiNativeSource reads Kalshi's perpetual futures (CFTC-regulated
// US exchange, margin account, launched 2026) from the public, no-auth
// margin endpoints:
//
//	GET https://external-api.kalshi.com/trade-api/v2/margin/markets
//	GET https://external-api.kalshi.com/trade-api/v2/margin/funding_rates/historical?limit=200
//
// Every market row carries the 24 h traded notional and the open
// interest in dollars (volume_24h_notional_value_dollars,
// open_interest_notional_value_dollars) plus an asset_class (Crypto,
// Metals as of 2026-09), so one call covers volume, OI, market count
// and breadth. Funding is settled every 8 hours (00:00, 08:00, 16:00
// ET); the historical endpoint returns the last settled rate per
// market, published as bps per 24 h hold (rate x 3 x 10,000).
//
// Derived metrics:
//
//	volume_24h_usd            = sum(volume_24h_notional_value_dollars) over active markets
//	oi_usd                    = sum(open_interest_notional_value_dollars)
//	active_markets            = count(status == "active")
//	top_market_volume_24h_usd = max(volume_24h_notional_value_dollars)
//	funding (BTC, ETH, SOL)   = last funding_rate x 3 x 10000 bps per day, 8 h interval
type KalshiNativeSource struct {
	client *http.Client
}

func NewKalshiNativeSource() *KalshiNativeSource {
	return &KalshiNativeSource{client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *KalshiNativeSource) Name() string { return srcKalshiNative }

type kalshiMarket struct {
	Ticker       string `json:"ticker"`
	Status       string `json:"status"`
	AssetClass   string `json:"asset_class"`
	Volume24hUSD string `json:"volume_24h_notional_value_dollars"`
	OIUSD        string `json:"open_interest_notional_value_dollars"`
}

type kalshiMarketsResponse struct {
	Markets []kalshiMarket `json:"markets"`
}

type kalshiFundingResponse struct {
	FundingRates []struct {
		MarketTicker string  `json:"market_ticker"`
		FundingRate  float64 `json:"funding_rate"`
		FundingTime  string  `json:"funding_time"`
	} `json:"funding_rates"`
}

// kalshiBase turns a market ticker (KXBTCPERP, KXKSHIBPERP) into the
// base symbol the rest of the harness uses (BTC, KSHIB).
func kalshiBase(ticker string) string {
	return strings.TrimSuffix(strings.TrimPrefix(ticker, "KX"), "PERP")
}

func (s *KalshiNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "kalshi"

	body, err := s.get("https://external-api.kalshi.com/trade-api/v2/margin/markets")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcKalshiNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err markets: %v\n", venue, srcKalshiNative, err)
		return res, nil
	}
	var parsed kalshiMarketsResponse
	if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Markets) == 0 {
		perpCohortFetchErrors.WithLabelValues(venue, srcKalshiNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse markets: %v (%d rows)\n", venue, srcKalshiNative, err, len(parsed.Markets))
		return res, nil
	}

	var volSum, oiSum, topVol float64
	var active int
	breadth := breadthCounter{}
	for _, m := range parsed.Markets {
		if m.Status != "active" {
			continue
		}
		active++
		v, _ := strconv.ParseFloat(m.Volume24hUSD, 64)
		volSum += v
		if v > topVol {
			topVol = v
		}
		oi, _ := strconv.ParseFloat(m.OIUSD, 64)
		oiSum += oi
		base := kalshiBase(m.Ticker)
		switch m.AssetClass {
		case "Crypto":
			breadth.add(classCrypto)
			res.AddCryptoSymbol(baseSymbol(base))
		case "Metals", "Energy", "Commodities":
			breadth.add(classCommodities)
			res.AddRWASymbol(baseSymbol(base))
		case "Equities", "Stocks", "ETFs":
			breadth.add(classStocks)
			res.AddRWASymbol(baseSymbol(base))
		case "Indices":
			breadth.add(classIndices)
			res.AddRWASymbol(baseSymbol(base))
		case "FX", "Forex":
			breadth.add(classForex)
			res.AddRWASymbol(baseSymbol(base))
		default:
			// An asset class this list does not know yet: the symbol
			// tables decide, a miss counts as a stock (Kalshi lists no
			// token that is not also a major on the cohort venues).
			breadth.add(rwaClass(baseSymbol(base)))
			res.AddRWASymbol(baseSymbol(base))
		}
	}
	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	res.SetBreadth(venue, breadth)

	// Funding: the last settled 8 h rate per market. The endpoint is
	// newest first across every market; 200 rows cover the 25 markets
	// over the last two settlements.
	fb, err := s.get("https://external-api.kalshi.com/trade-api/v2/margin/funding_rates/historical?limit=200")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcKalshiNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err funding: %v\n", venue, srcKalshiNative, err)
	} else {
		var fr kalshiFundingResponse
		if err := json.Unmarshal(fb, &fr); err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcKalshiNative, "parse").Inc()
		} else {
			seen := map[string]bool{}
			for _, r := range fr.FundingRates {
				base := kalshiBase(r.MarketTicker)
				if seen[base] {
					continue
				}
				seen[base] = true
				switch base {
				case "BTC", "ETH", "SOL":
					res.SetFunding(venue, base, fundingPoint{Bps24h: r.FundingRate * 3 * 10000, IntervalHours: 8})
				}
			}
		}
	}

	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d vol24h=%.0f oi=%.0f top24h=%.0f breadth: %s\n",
		venue, srcKalshiNative, active, volSum, oiSum, topVol, breadth)
	return res, nil
}

func (s *KalshiNativeSource) get(url string) ([]byte, error) {
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
