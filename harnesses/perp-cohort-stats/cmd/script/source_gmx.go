package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"time"
)

// GMXNativeSource queries the GMX V2 Synthetics 24h rolling volume via the
// public Subsquid squids hosted at gmx.squids.live. Two chains are queried
// in parallel: Arbitrum and Avalanche.
//
// Endpoint:
//
//	POST https://gmx.squids.live/gmx-synthetics-{chain}/graphql
//
// Previous sources and why they were abandoned:
//   - stats.gmx.io: dead as of 2026-08, DNS no longer resolves.
//   - arbitrum-api.gmxinfra.io: price oracle only; /volumes and /stats 404.
//   - The Graph / Goldsky: GMX V2 synthetics subgraph needs a paid API key.
//   - api.gmx.io/daily_volume: GMX V1 GLP swap volume only, not V2 perps.
//   - DefiLlama: derivatives volume behind the paid plan (402).
//
// The Subsquid endpoint is public (no auth). volumeUsd is a GraphQL BigInt
// string scaled by 1e30 (GMX internal USD representation). The query fetches
// the most recent "1d" period bucket where timestamp >= now-86400s.
//
// Derived metrics:
//
//	volume_24h_usd = (arb_volumeUsd + avax_volumeUsd) / 1e30
type GMXNativeSource struct {
	client *http.Client
}

func NewGMXNativeSource() *GMXNativeSource {
	return &GMXNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *GMXNativeSource) Name() string { return srcGMXNative }

const gmxSquidBase = "https://gmx.squids.live/gmx-synthetics-%s/graphql"

// gmxScale1e30 is the divisor to convert GMX's internal 1e30-scaled USD BigInt
// to a float64 dollar amount.
var gmxScale1e30 = func() *big.Float {
	exp := new(big.Int).Exp(big.NewInt(10), big.NewInt(30), nil)
	return new(big.Float).SetPrec(128).SetInt(exp)
}()

type gmxVolumeInfoItem struct {
	ID        string `json:"id"`
	VolumeUsd string `json:"volumeUsd"`
	Timestamp int64  `json:"timestamp"`
}

type gmxSquidResp struct {
	Data struct {
		VolumeInfos []gmxVolumeInfoItem `json:"volumeInfos"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

func (s *GMXNativeSource) fetchChain(chain string, since int64) (float64, error) {
	url := fmt.Sprintf(gmxSquidBase, chain)
	queryStr := fmt.Sprintf(
		`{ volumeInfos(where:{period_eq:"1d", timestamp_gte:%d}, limit:1, orderBy:timestamp_DESC) { id volumeUsd timestamp } }`,
		since,
	)
	payload, _ := json.Marshal(map[string]string{"query": queryStr})
	req, _ := http.NewRequest("POST", url, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	req.Header.Set("Accept", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("status_%d", resp.StatusCode)
	}

	var parsed gmxSquidResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	if len(parsed.Errors) > 0 {
		return 0, fmt.Errorf("graphql: %s", parsed.Errors[0].Message)
	}
	if len(parsed.Data.VolumeInfos) == 0 {
		return 0, nil
	}

	raw := parsed.Data.VolumeInfos[0].VolumeUsd
	n := new(big.Int)
	if _, ok := n.SetString(raw, 10); !ok {
		return 0, fmt.Errorf("parse_bigint: %s", raw)
	}
	scaled := new(big.Float).SetPrec(128).SetInt(n)
	scaled.Quo(scaled, gmxScale1e30)
	vol, _ := scaled.Float64()
	return vol, nil
}

func (s *GMXNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "gmx-v2"
	since := time.Now().Unix() - 86400

	type chainResult struct {
		chain string
		vol   float64
		err   error
	}
	ch := make(chan chainResult, 2)
	for _, chain := range []string{"arbitrum", "avalanche"} {
		go func(c string) {
			vol, err := s.fetchChain(c, since)
			ch <- chainResult{c, vol, err}
		}(chain)
	}

	var total float64
	for i := 0; i < 2; i++ {
		r := <-ch
		if r.err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcGMXNative, classifyError(r.err.Error())).Inc()
			fmt.Printf("[perp-cohort][%s][%s] err %s: %v\n", venue, srcGMXNative, r.chain, r.err)
		} else {
			fmt.Printf("[perp-cohort][%s][%s] %s vol24h=%.0f\n", venue, srcGMXNative, r.chain, r.vol)
			total += r.vol
		}
	}
	res.SetIfPositive(venue, mVolume24h, total)
	return res, nil
}
