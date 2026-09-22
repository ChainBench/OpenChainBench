package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// HyperliquidNativeSource calls the public info endpoint:
//
//	POST https://api.hyperliquid.xyz/info  body: {"type":"metaAndAssetCtxs"}
//
// The response is a tuple `[meta, ctxs]`:
//   - meta.universe is an array of assets (BTC, ETH, ATOM, ...) with
//     szDecimals and a possible `isDelisted` flag.
//   - ctxs is a parallel array of contexts, each with stringified
//     numeric fields: markPx, openInterest, dayNtlVlm (notional 24h
//     volume in USD), funding, prevDayPx.
//
// Derived metrics:
//
//	volume_24h_usd            = sum(dayNtlVlm)
//	oi_usd                    = sum(openInterest * markPx)
//	active_markets            = count(non-delisted universe entries)
//	top_market_volume_24h_usd = max(dayNtlVlm)
type HyperliquidNativeSource struct {
	client *http.Client

	// HIP-3 breadth cache: the deployer dex list and one meta call per
	// dex are refreshed every hlDexCacheTTL, not every 60 s tick.
	dexMu      sync.Mutex
	dexSymbols []string
	dexTS      time.Time
}

// hlDexCacheTTL bounds the perpDexs + per-dex meta fan-out (11 calls
// as of 2026-09) to one refresh per 10 minutes.
const hlDexCacheTTL = 10 * time.Minute

// hlPerpDex is one entry of POST /info {"type":"perpDexs"}; the first
// element is null (the core dex) and is skipped.
type hlPerpDex struct {
	Name string `json:"name"`
}

func NewHyperliquidNativeSource() *HyperliquidNativeSource {
	return &HyperliquidNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *HyperliquidNativeSource) Name() string { return srcHLNative }

type hlMeta struct {
	Universe []hlUniverseEntry `json:"universe"`
}

type hlUniverseEntry struct {
	Name       string `json:"name"`
	IsDelisted bool   `json:"isDelisted"`
}

// hlCtx fields arrive as JSON strings; we parse manually rather than
// drop a flexFloat custom unmarshaler here because the struct is tight.
type hlCtx struct {
	DayNtlVlm    string `json:"dayNtlVlm"`
	OpenInterest string `json:"openInterest"`
	MarkPx       string `json:"markPx"`
	Funding      string `json:"funding"`
}

func (s *HyperliquidNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "hyperliquid"

	url := "https://api.hyperliquid.xyz/info"
	body, err := s.post(url, []byte(`{"type":"metaAndAssetCtxs"}`))
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcHLNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcHLNative, err)
		return res, nil
	}

	// Response shape: [meta, ctxs]. meta is decoded once for universe
	// length / delisted flags, ctxs is decoded as an array of objects.
	var raw []json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil || len(raw) != 2 {
		perpCohortFetchErrors.WithLabelValues(venue, srcHLNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: parse top-level: %v\n", venue, srcHLNative, err)
		return res, nil
	}
	var meta hlMeta
	if err := json.Unmarshal(raw[0], &meta); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcHLNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: parse meta: %v\n", venue, srcHLNative, err)
		return res, nil
	}
	var ctxs []hlCtx
	if err := json.Unmarshal(raw[1], &ctxs); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcHLNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: parse ctxs: %v\n", venue, srcHLNative, err)
		return res, nil
	}

	var volSum, oiSum, topVol float64
	var activeCount int
	for i, c := range ctxs {
		if i >= len(meta.Universe) {
			break
		}
		if meta.Universe[i].IsDelisted {
			continue
		}
		activeCount++
		v := parseFloat(c.DayNtlVlm)
		volSum += v
		if v > topVol {
			topVol = v
		}
		oi := parseFloat(c.OpenInterest)
		mark := parseFloat(c.MarkPx)
		oiSum += oi * mark
	}

	// Skip metrics that came back as zero. A truly zero value means the
	// venue is dead, the upstream had an outage, or the response shape
	// drifted: in every case carry-forward beats overwriting with 0.
	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mActiveMarkets, float64(activeCount))
	res.SetIfPositive(venue, mTopVol24h, topVol)

	// Asset-class breadth. The core universe is crypto by construction;
	// the HIP-3 deployer dexes (xyz, para, mkts, io...) list equities,
	// ETFs, FX, indices and commodities under `dex:SYMBOL` names and
	// are classified per symbol in breadth.go, with the core universe
	// as the known-crypto set (a HIP-3 dex relisting a core coin stays
	// crypto).
	for _, u := range meta.Universe {
		if !u.IsDelisted {
			res.AddCryptoSymbol(baseSymbol(u.Name))
		}
	}
	if syms := s.hip3Symbols(); syms != nil {
		res.SetBreadth(venue, breadthCounter{classCrypto: activeCount})
		res.SetUnclassified(venue, syms)
	}
	fmt.Printf("[perp-cohort][%s][%s] ok: active=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcHLNative, activeCount, volSum, oiSum, topVol)
	return res, nil
}

// hip3Symbols returns the base symbols of every HIP-3 dex market, from
// the cache when it is younger than hlDexCacheTTL. The classification
// happens in the router (classifyUnclassified) once every source has
// reported its crypto symbols, so a token perp on a deployer dex is not
// mistaken for a stock. Returns nil when the dex list cannot be fetched
// and nothing is cached, so the venue keeps its previous gauges instead
// of publishing a crypto-only count.
func (s *HyperliquidNativeSource) hip3Symbols() []string {
	s.dexMu.Lock()
	defer s.dexMu.Unlock()
	if s.dexSymbols != nil && time.Since(s.dexTS) < hlDexCacheTTL {
		return append([]string(nil), s.dexSymbols...)
	}
	body, err := s.post("https://api.hyperliquid.xyz/info", []byte(`{"type":"perpDexs"}`))
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("hyperliquid", srcHLNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][hyperliquid][%s] perpDexs err: %v\n", srcHLNative, err)
		return s.cachedDexSymbols()
	}
	var dexs []*hlPerpDex
	if err := json.Unmarshal(body, &dexs); err != nil {
		perpCohortFetchErrors.WithLabelValues("hyperliquid", srcHLNative, "parse").Inc()
		return s.cachedDexSymbols()
	}
	var syms []string
	var dexCount int
	for _, d := range dexs {
		if d == nil || d.Name == "" {
			continue
		}
		mb, err := s.post("https://api.hyperliquid.xyz/info", []byte(fmt.Sprintf(`{"type":"meta","dex":%q}`, d.Name)))
		if err != nil {
			perpCohortFetchErrors.WithLabelValues("hyperliquid", srcHLNative, classifyError(err.Error())).Inc()
			fmt.Printf("[perp-cohort][hyperliquid][%s] meta dex=%s err: %v\n", srcHLNative, d.Name, err)
			// One dex missing would understate the count for 10 minutes;
			// keep the previous snapshot instead.
			return s.cachedDexSymbols()
		}
		var m hlMeta
		if err := json.Unmarshal(mb, &m); err != nil {
			perpCohortFetchErrors.WithLabelValues("hyperliquid", srcHLNative, "parse").Inc()
			return s.cachedDexSymbols()
		}
		dexCount++
		for _, u := range m.Universe {
			if !u.IsDelisted {
				syms = append(syms, baseSymbol(u.Name))
			}
		}
	}
	if dexCount == 0 {
		// A 200 that carries no usable dex (renamed field, list holding
		// only the leading null) is a parse failure, not an empty catalog.
		perpCohortFetchErrors.WithLabelValues("hyperliquid", srcHLNative, "parse").Inc()
		fmt.Printf("[perp-cohort][hyperliquid][%s] perpDexs: no usable dex in %d entries\n", srcHLNative, len(dexs))
		return s.cachedDexSymbols()
	}
	s.dexSymbols = syms
	s.dexTS = time.Now()
	fmt.Printf("[perp-cohort][hyperliquid][%s] hip3: %d dexes, %d markets\n", srcHLNative, dexCount, len(syms))
	return append([]string(nil), syms...)
}

func (s *HyperliquidNativeSource) cachedDexSymbols() []string {
	if s.dexSymbols == nil {
		return nil
	}
	return append([]string(nil), s.dexSymbols...)
}

func (s *HyperliquidNativeSource) post(url string, body []byte) ([]byte, error) {
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(b), 200))
	}
	return b, nil
}

func parseFloat(s string) float64 {
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}
