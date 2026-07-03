package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// VertexNativeSource hits the Vertex (now rebranded "Nado") indexer:
//
//	GET  https://gateway.prod.nado.xyz/v1/symbols        (perp universe)
//	POST https://archive.prod.nado.xyz/v1                (market_snapshots)
//
// The /symbols call returns the full product catalog typed as
// `spot` or `perp`. We keep entries with type=="perp" and
// trading_status=="live" to build the perp universe.
//
// The archive market_snapshots call returns cumulative metrics
// keyed by product_id. Because the volume field is cumulative since
// inception, we request two snapshots 24h apart and diff them to get
// the 24h volume. Open interest is reported at the snapshot timestamp
// (BASE units) and converted to USD using the latest oracle_price.
// All fields are stringified x18-scaled big integers; we cast through
// big.Int and big.Float to preserve precision.
//
// For 30d aggregates we issue a second market_snapshots call with
// 31 daily granules and sum the successive cumulative_volumes /
// cumulative_(taker+maker)_fees deltas per market. DefiLlama's
// vertex-perps page returns null for both metrics so the native path
// is the only signal we have for vol30d / fees30d.
//
// Derived metrics:
//
//	volume_24h_usd            = sum(now.cumulative_volumes[pid] - prior.cumulative_volumes[pid]) / 1e18
//	volume_30d_usd            = sum_over_markets(sum_over_30_daily_deltas(cumulative_volumes)) / 1e18
//	oi_usd                    = sum(now.open_interests[pid]) / 1e18  (the field is already quoted in USD)
//	fees_30d_usd              = sum_over_markets(sum_over_30_daily_deltas(cumulative_taker_fees + cumulative_maker_fees)) / 1e18
//	active_markets            = count(perp products with trading_status == "live")
//	top_market_volume_24h_usd = max single-product 24h volume
type VertexNativeSource struct {
	client *http.Client
}

func NewVertexNativeSource() *VertexNativeSource {
	return &VertexNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *VertexNativeSource) Name() string { return srcVertexNative }

type vertexSymbol struct {
	Type          string `json:"type"`
	ProductID     int    `json:"product_id"`
	Symbol        string `json:"symbol"`
	TradingStatus string `json:"trading_status"`
}

type vertexSnapshot struct {
	Timestamp             int64             `json:"timestamp"`
	CumulativeVolumes     map[string]string `json:"cumulative_volumes"`
	OpenInterests         map[string]string `json:"open_interests"`
	CumulativeTakerFees   map[string]string `json:"cumulative_taker_fees"`
	CumulativeMakerFees   map[string]string `json:"cumulative_maker_fees"`
}

type vertexSnapshotResponse struct {
	Snapshots []vertexSnapshot `json:"snapshots"`
}

func (s *VertexNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "vertex"

	// Step 1: enumerate live perp products.
	symbolsBody, err := s.get("https://gateway.prod.nado.xyz/v1/symbols")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcVertexNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err symbols: %v\n", venue, srcVertexNative, err)
		return res, nil
	}
	var symbols []vertexSymbol
	if err := json.Unmarshal(symbolsBody, &symbols); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcVertexNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse symbols: %v\n", venue, srcVertexNative, err)
		return res, nil
	}
	var perpIDs []int
	for _, sym := range symbols {
		if sym.Type != "perp" || sym.TradingStatus != "live" {
			continue
		}
		perpIDs = append(perpIDs, sym.ProductID)
	}
	if len(perpIDs) == 0 {
		return res, nil
	}

	// Step 2: fetch 2 snapshots 24h apart; diff cumulative volumes.
	body, err := s.postSnapshots(perpIDs)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcVertexNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err archive: %v\n", venue, srcVertexNative, err)
		// Still publish active_markets from the symbols call.
		res.SetIfPositive(venue, mActiveMarkets, float64(len(perpIDs)))
		return res, nil
	}
	var parsed vertexSnapshotResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcVertexNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse archive: %v\n", venue, srcVertexNative, err)
		res.SetIfPositive(venue, mActiveMarkets, float64(len(perpIDs)))
		return res, nil
	}
	if len(parsed.Snapshots) < 2 {
		fmt.Printf("[perp-cohort][%s][%s] only %d snapshots returned, need 2 for volume diff\n",
			venue, srcVertexNative, len(parsed.Snapshots))
		res.SetIfPositive(venue, mActiveMarkets, float64(len(perpIDs)))
		return res, nil
	}

	now := parsed.Snapshots[0]
	prior := parsed.Snapshots[1]

	var volSum, oiSum, topVol float64
	for _, pid := range perpIDs {
		key := fmt.Sprintf("%d", pid)
		// 24h volume = (now - prior) cumulative, dropped to USD.
		vDelta := subX18ToFloat(now.CumulativeVolumes[key], prior.CumulativeVolumes[key])
		if vDelta > 0 {
			volSum += vDelta
			if vDelta > topVol {
				topVol = vDelta
			}
		}
		// OI is already in quoted USDC (the SDK calls it `openInterestsQuote`)
		// at 18 decimals, so we just remove the 1e18 scale to get USD.
		oiSum += removeX18(now.OpenInterests[key])
	}

	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(len(perpIDs)))
	res.SetIfPositive(venue, mTopVol24h, topVol)

	// Step 3: 30d aggregates. Separate archive call with 31 daily granules
	// so we can diff successive cumulatives. We tolerate a partial response
	// (e.g. archive returns 12 of the 31 snapshots): the daily-delta sum
	// still represents the realized trailing window we observed, and
	// SetIfPositive keeps us from overwriting carry-forward on a hard miss.
	vol30dSum, fees30dSum, snapCount, ok30d := s.fetch30dAggregates(perpIDs, venue)
	if ok30d {
		res.SetIfPositive(venue, mVolume30d, vol30dSum)
		res.SetIfPositive(venue, mFees30d, fees30dSum)
	}

	fmt.Printf("[perp-cohort][%s][%s] ok: perps=%d vol24h=%.0f oi=%.0f top24h=%.0f vol30d=%.0f fees30d=%.0f snaps30d=%d\n",
		venue, srcVertexNative, len(perpIDs), volSum, oiSum, topVol, vol30dSum, fees30dSum, snapCount)
	return res, nil
}

// fetch30dAggregates issues a second market_snapshots call for the 30d
// window. Returns (vol30d, fees30d, snapshotsSeen, ok). ok=false means
// the call or parse failed end to end; partial snapshot counts still
// return ok=true so the caller can publish what it has.
func (s *VertexNativeSource) fetch30dAggregates(productIDs []int, venue string) (float64, float64, int, bool) {
	body, err := s.postSnapshotsWindow(productIDs, 31, 86400)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcVertexNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err archive(30d): %v\n", venue, srcVertexNative, err)
		return 0, 0, 0, false
	}
	var parsed vertexSnapshotResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcVertexNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse archive(30d): %v\n", venue, srcVertexNative, err)
		return 0, 0, 0, false
	}
	if len(parsed.Snapshots) < 2 {
		fmt.Printf("[perp-cohort][%s][%s] only %d snapshots returned for 30d window, need >=2\n",
			venue, srcVertexNative, len(parsed.Snapshots))
		return 0, 0, len(parsed.Snapshots), false
	}

	// Archive returns snapshots ordered newest-first. We walk pairs
	// (snapshots[i], snapshots[i+1]) and sum each positive delta into
	// the per-market accumulator, then sum across markets.
	var vol30d, fees30d float64
	for i := 0; i < len(parsed.Snapshots)-1; i++ {
		newer := parsed.Snapshots[i]
		older := parsed.Snapshots[i+1]
		for _, pid := range productIDs {
			key := fmt.Sprintf("%d", pid)
			vol30d += subX18ToFloat(newer.CumulativeVolumes[key], older.CumulativeVolumes[key])
			takerDelta := subX18ToFloat(newer.CumulativeTakerFees[key], older.CumulativeTakerFees[key])
			makerDelta := subX18ToFloat(newer.CumulativeMakerFees[key], older.CumulativeMakerFees[key])
			fees30d += takerDelta + makerDelta
		}
	}
	return vol30d, fees30d, len(parsed.Snapshots), true
}

func (s *VertexNativeSource) postSnapshots(productIDs []int) ([]byte, error) {
	return s.postSnapshotsWindow(productIDs, 2, 86400)
}

// postSnapshotsWindow issues a market_snapshots call with the given
// granule count and granularity (seconds). The archive endpoint caps
// `count` at ~31 in practice; callers should not exceed that.
func (s *VertexNativeSource) postSnapshotsWindow(productIDs []int, count, granularity int) ([]byte, error) {
	body := map[string]any{
		"market_snapshots": map[string]any{
			"interval": map[string]any{
				"count":       count,
				"granularity": granularity,
			},
			"product_ids": productIDs,
		},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequest("POST", "https://archive.prod.nado.xyz/v1", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	req.Header.Set("Accept", "application/json")
	// The archive gateway rejects clients that don't advertise gzip.
	req.Header.Set("Accept-Encoding", "gzip")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	return readMaybeGzip(resp)
}

func (s *VertexNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "gzip")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	return readMaybeGzip(resp)
}

func readMaybeGzip(resp *http.Response) ([]byte, error) {
	var reader io.ReadCloser = resp.Body
	if strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
		gz, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, fmt.Errorf("gzip: %w", err)
		}
		defer gz.Close()
		reader = io.NopCloser(gz)
	}
	body, _ := io.ReadAll(reader)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

// subX18ToFloat returns float64((a - b) / 1e18). Inputs are decimal
// integer strings of arbitrary length, so we use big.Int math first
// and only down-cast at the very end. Negative deltas (snapshot order
// reversed, late-arriving rows) round to 0 since the caller treats
// SetIfPositive as the publish gate.
func subX18ToFloat(a, b string) float64 {
	ai, aok := new(big.Int).SetString(a, 10)
	bi, bok := new(big.Int).SetString(b, 10)
	if !aok || !bok {
		return 0
	}
	delta := new(big.Int).Sub(ai, bi)
	if delta.Sign() <= 0 {
		return 0
	}
	f := new(big.Float).SetInt(delta)
	f.Quo(f, big.NewFloat(1e18))
	v, _ := f.Float64()
	return v
}

// removeX18 returns float64(a / 1e18). Used for fields the indexer
// publishes at the standard Nado 18-decimal scale.
func removeX18(a string) float64 {
	ai, ok := new(big.Int).SetString(a, 10)
	if !ok {
		return 0
	}
	f := new(big.Float).SetInt(ai)
	f.Quo(f, big.NewFloat(1e18))
	v, _ := f.Float64()
	return v
}
