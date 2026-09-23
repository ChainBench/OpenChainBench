package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// JupiterNativeSource reads Jupiter Perpetuals (Solana, JLP pool as the
// counterparty, three markets) from the public perps API:
//
//	GET https://perps-api.jup.ag/v1/market-stats?mint=<mint>  (24 h volume per market)
//	GET https://perps-api.jup.ag/v1/jlp-info                  (pool custodies)
//
// Open interest is not published as such. Each custody row carries
// `locked` (tokens reserved for the longs' maximum payout, i.e. the
// long size in native units), `globalShortSizes` (short size in USD,
// 6 decimals) and the pair aumUsd / aumTokenAmount, whose ratio is the
// USD value of one native unit. Long OI = locked x that ratio; total OI
// = long + short, per market, summed.
//
// Jupiter charges hourly borrow fees rather than funding, so no funding
// row is published for the venue.
//
// Derived metrics:
//
//	volume_24h_usd            = sum(market-stats.volume) over SOL, ETH, WBTC
//	oi_usd                    = sum(locked x aumUsd / aumTokenAmount + globalShortSizes) / 1e6
//	active_markets            = markets with a market-stats answer
//	top_market_volume_24h_usd = max(volume)
type JupiterNativeSource struct {
	client *http.Client
}

func NewJupiterNativeSource() *JupiterNativeSource {
	return &JupiterNativeSource{client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *JupiterNativeSource) Name() string { return srcJupiterNative }

// jupiterMarkets: base symbol -> custody mint (the perps API keys
// markets by the token mint).
var jupiterMarkets = []struct{ Base, Mint string }{
	{"SOL", "So11111111111111111111111111111111111111112"},
	{"ETH", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"},
	{"BTC", "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"},
}

type jupiterMarketStats struct {
	Volume string `json:"volume"`
}

type jupiterJLPInfo struct {
	Custodies []struct {
		Symbol           string `json:"symbol"`
		Mint             string `json:"mint"`
		AumUsd           string `json:"aumUsd"`
		AumTokenAmount   string `json:"aumTokenAmount"`
		Locked           string `json:"locked"`
		GlobalShortSizes string `json:"globalShortSizes"`
	} `json:"custodies"`
}

func (s *JupiterNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "jupiter"

	var volSum, topVol float64
	var active int
	breadth := breadthCounter{}
	for _, m := range jupiterMarkets {
		body, err := s.get("https://perps-api.jup.ag/v1/market-stats?mint=" + m.Mint)
		if err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcJupiterNative, classifyError(err.Error())).Inc()
			fmt.Printf("[perp-cohort][%s][%s] err market-stats %s: %v\n", venue, srcJupiterNative, m.Base, err)
			continue
		}
		var st jupiterMarketStats
		if err := json.Unmarshal(body, &st); err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcJupiterNative, "parse").Inc()
			continue
		}
		v, _ := strconv.ParseFloat(st.Volume, 64)
		active++
		volSum += v
		if v > topVol {
			topVol = v
		}
		breadth.add(classCrypto)
		res.AddCryptoSymbol(m.Base)
	}
	if active == 0 {
		return res, nil
	}
	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(active))
	res.SetIfPositive(venue, mTopVol24h, topVol)
	res.SetBreadth(venue, breadth)

	var oiSum float64
	body, err := s.get("https://perps-api.jup.ag/v1/jlp-info")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcJupiterNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err jlp-info: %v\n", venue, srcJupiterNative, err)
	} else {
		var info jupiterJLPInfo
		if err := json.Unmarshal(body, &info); err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcJupiterNative, "parse").Inc()
		} else {
			mints := map[string]bool{}
			for _, m := range jupiterMarkets {
				mints[m.Mint] = true
			}
			for _, c := range info.Custodies {
				if !mints[c.Mint] {
					continue
				}
				aumUsd, _ := strconv.ParseFloat(c.AumUsd, 64)
				aumTok, _ := strconv.ParseFloat(c.AumTokenAmount, 64)
				locked, _ := strconv.ParseFloat(c.Locked, 64)
				short, _ := strconv.ParseFloat(c.GlobalShortSizes, 64)
				var long float64
				if aumTok > 0 {
					long = locked * aumUsd / aumTok
				}
				oiSum += (long + short) / 1e6
			}
			res.SetIfPositive(venue, mOI, oiSum)
		}
	}
	fmt.Printf("[perp-cohort][%s][%s] ok: markets=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcJupiterNative, active, volSum, oiSum, topVol)
	return res, nil
}

func (s *JupiterNativeSource) get(url string) ([]byte, error) {
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
