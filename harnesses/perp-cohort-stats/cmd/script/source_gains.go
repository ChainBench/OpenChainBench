package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"
)

// GainsNativeSource derives Gains Network's trailing 24h trading volume
// from the stats backend's daily snapshots, summed across chains.
//
// Endpoint (one call per chain):
//
//	GET https://backend-global.gains.trade/api/stats?chainId=<id>
//
// Each row carries `leveraged_volume`, the chain's all-time cumulative
// notional, snapshotted once a day around 23:37 UTC plus a live row for
// the current day. 24h volume = (latest - previous) scaled to 24 h by the
// interval between the two rows.
//
// History: v1 read https://stats.gains.trade/volume (rolling 24h, all
// chains). That host started answering Cloudflare 1016 (origin DNS error)
// on 2026-09-10 and the gauge froze at $44M for days; DeFiLlama's perp
// volume is paid-only, so there was no fallback. The cumulative counter
// also jumps when Gains re-indexes its history (+$29B on 2026-09-03,
// +$27B on 2026-09-07): a delta far above the median of recent daily
// deltas is treated as a re-index and the previous clean delta is used.
//
// Derived metrics:
//
//	volume_24h_usd = sum over chains of the latest clean daily delta, per 24 h
type GainsNativeSource struct {
	client *http.Client
	base   string
}

func NewGainsNativeSource() *GainsNativeSource {
	return &GainsNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
		base:   "https://backend-global.gains.trade",
	}
}

func (s *GainsNativeSource) Name() string { return srcGainsNative }

// Chains with a stats series on the backend (Arbitrum, Base, Polygon,
// MegaETH). ApeChain (33139) answers an empty series and is left out.
var gainsChainIDs = []int{42161, 8453, 137, 4326}

type gainsStatsRow struct {
	Date            string  `json:"date"`
	LeveragedVolume float64 `json:"leveraged_volume"`
}

type gainsStatsResp struct {
	Stats []gainsStatsRow `json:"stats"`
}

// gainsReindexFactor: a daily delta above this multiple of the median of
// recent deltas is a history re-index, not trading. Real busy days reach
// 10-15x a quiet week (2026-09-14 was 10x); the re-indexes seen so far
// were 500x and more, so 40 separates them with margin on both sides.
const gainsReindexFactor = 40

// gainsVolume24hFromRows returns the trailing 24h volume implied by a
// chain's snapshot rows (any order), or 0 when it cannot be determined.
// Exported for tests.
func gainsVolume24hFromRows(rows []gainsStatsRow, now time.Time) float64 {
	type pt struct {
		t time.Time
		v float64
	}
	pts := make([]pt, 0, len(rows))
	for _, r := range rows {
		t, err := time.Parse(time.RFC3339, r.Date)
		if err != nil || r.LeveragedVolume <= 0 || t.After(now.Add(time.Hour)) {
			continue
		}
		pts = append(pts, pt{t, r.LeveragedVolume})
	}
	sort.Slice(pts, func(i, j int) bool { return pts[i].t.Before(pts[j].t) })
	if len(pts) < 2 {
		return 0
	}
	// Per-24h rates between consecutive snapshots.
	type delta struct {
		rate float64 // USD per 24 h
		hrs  float64
	}
	deltas := make([]delta, 0, len(pts)-1)
	for i := 1; i < len(pts); i++ {
		hrs := pts[i].t.Sub(pts[i-1].t).Hours()
		d := pts[i].v - pts[i-1].v
		if hrs < 1 || d <= 0 {
			continue
		}
		deltas = append(deltas, delta{rate: d * 24 / hrs, hrs: hrs})
	}
	if len(deltas) == 0 {
		return 0
	}
	rates := make([]float64, len(deltas))
	for i, d := range deltas {
		rates[i] = d.rate
	}
	sort.Float64s(rates)
	median := rates[len(rates)/2]
	// Walk back from the newest delta to the first one that is not a
	// re-index jump. The newest is usually today's live row vs last
	// night's snapshot (~20-24 h), which is the freshest honest number.
	for i := len(deltas) - 1; i >= 0; i-- {
		if len(deltas) < 3 || deltas[i].rate <= median*gainsReindexFactor {
			return deltas[i].rate
		}
	}
	return 0
}

func (s *GainsNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "gains"
	now := time.Now().UTC()

	var total float64
	chainsOK := 0
	arbOK := false
	for _, chainID := range gainsChainIDs {
		body, err := s.get(fmt.Sprintf("%s/api/stats?chainId=%d", s.base, chainID))
		if err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcGainsNative, classifyError(err.Error())).Inc()
			fmt.Printf("[perp-cohort][%s][%s] chain=%d err: %v\n", venue, srcGainsNative, chainID, err)
			continue
		}
		var resp gainsStatsResp
		if err := json.Unmarshal(body, &resp); err != nil {
			perpCohortFetchErrors.WithLabelValues(venue, srcGainsNative, "parse").Inc()
			fmt.Printf("[perp-cohort][%s][%s] chain=%d err parse: %v\n", venue, srcGainsNative, chainID, err)
			continue
		}
		v := gainsVolume24hFromRows(resp.Stats, now)
		if v > 0 {
			chainsOK++
			total += v
			if chainID == 42161 {
				arbOK = true
			}
			fmt.Printf("[perp-cohort][%s][%s]   chain=%d vol24h=%.0f\n", venue, srcGainsNative, chainID, v)
		}
	}

	// Arbitrum carries nearly all of the volume; without it the sum would
	// understate the venue by an order of magnitude, so publish nothing
	// (the gauge keeps its last value and the freshness surface flags it).
	if arbOK && total > 0 {
		res.SetIfPositive(venue, mVolume24h, total)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f (chains=%d)\n", venue, srcGainsNative, total, chainsOK)
	}
	return res, nil
}

func (s *GainsNativeSource) get(url string) ([]byte, error) {
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
