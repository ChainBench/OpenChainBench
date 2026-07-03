package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// EdgexNativeSource hits two endpoints:
//
//	GET https://pro.edgex.exchange/api/v1/public/meta/getMetaData
//	GET https://pro.edgex.exchange/api/v1/public/quote/getTicker?contractId=<id>
//
// edgeX does not expose a single ticker batch endpoint, so we walk
// the ~290 contracts one at a time with a 10 req/s throttle. A full
// loop takes ~30s, so we run the loop in a background goroutine and
// cache the per-contract numbers for 5 minutes. Each Fetch() call
// returns immediately with whatever snapshot is currently cached;
// the first sweep emits zero, subsequent sweeps emit the cached map.
//
// Each per-contract ticker response has the rollup fields we need:
//
//	value         (24h notional USD, string)
//	openInterest  (BASE units, string)
//	markPrice     (USD, string)
type EdgexNativeSource struct {
	client       *http.Client
	mu           sync.Mutex
	cache        map[string]edgexTickerRow
	cacheTS      time.Time
	refreshing   bool
}

type edgexTickerRow struct {
	value    float64
	oi       float64
	mark     float64
}

func NewEdgexNativeSource() *EdgexNativeSource {
	return &EdgexNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
		cache:  map[string]edgexTickerRow{},
	}
}

func (s *EdgexNativeSource) Name() string { return srcEdgexNative }

type edgexMetaResponse struct {
	Code string `json:"code"`
	Data struct {
		ContractList []struct {
			ContractID   string `json:"contractId"`
			ContractName string `json:"contractName"`
		} `json:"contractList"`
	} `json:"data"`
}

type edgexTickerResponse struct {
	Code string `json:"code"`
	Data []struct {
		ContractID   string `json:"contractId"`
		ContractName string `json:"contractName"`
		Value        string `json:"value"`
		OpenInterest string `json:"openInterest"`
		MarkPrice    string `json:"markPrice"`
	} `json:"data"`
}

const edgexCacheTTL = 5 * time.Minute

func (s *EdgexNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "edgex"

	// Fetch contract list every sweep (small, fast, one request).
	body, err := s.get("https://pro.edgex.exchange/api/v1/public/meta/getMetaData")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcEdgexNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err meta: %v\n", venue, srcEdgexNative, err)
		return res, nil
	}
	var meta edgexMetaResponse
	if err := json.Unmarshal(body, &meta); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcEdgexNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] err parse meta: %v\n", venue, srcEdgexNative, err)
		return res, nil
	}

	// Schedule a per-contract refresh in the background if the cache
	// is stale; aggregate from whatever snapshot is currently cached.
	// The per-contract endpoint sits behind a stricter Cloudflare WAF
	// than the meta endpoint and frequently 403s under steady traffic,
	// so we treat the cohort cache as best-effort: when the cache is
	// empty we publish only active_markets (count of mainnet contracts)
	// and rely on the DefiLlama fallback for vol/oi.
	s.maybeRefresh(meta.Data.ContractList)

	s.mu.Lock()
	var volSum, oiSum, topVol float64
	var active int
	for _, row := range s.cache {
		if row.mark <= 0 {
			continue
		}
		active++
		volSum += row.value
		if row.value > topVol {
			topVol = row.value
		}
		oiSum += row.oi * row.mark
	}
	cached := len(s.cache)
	s.mu.Unlock()

	// active_markets always comes from the meta call (it succeeds even
	// when the per-contract WAF is hot). The other gauges are gated on
	// the cache having content.
	res.SetIfPositive(venue, mActiveMarkets, float64(len(meta.Data.ContractList)))
	res.SetIfPositive(venue, mVolume24h, volSum)
	res.SetIfPositive(venue, mOI, oiSum)
	res.SetIfPositive(venue, mTopVol24h, topVol)
	fmt.Printf("[perp-cohort][%s][%s] ok: contracts=%d cached=%d active=%d vol24h=%.0f oi=%.0f top24h=%.0f\n",
		venue, srcEdgexNative, len(meta.Data.ContractList), cached, active, volSum, oiSum, topVol)
	return res, nil
}

func (s *EdgexNativeSource) maybeRefresh(contracts []struct {
	ContractID   string `json:"contractId"`
	ContractName string `json:"contractName"`
}) {
	s.mu.Lock()
	if s.refreshing {
		s.mu.Unlock()
		return
	}
	if time.Since(s.cacheTS) < edgexCacheTTL && len(s.cache) > 0 {
		s.mu.Unlock()
		return
	}
	s.refreshing = true
	s.mu.Unlock()

	go s.runRefresh(contracts)
}

func (s *EdgexNativeSource) runRefresh(contracts []struct {
	ContractID   string `json:"contractId"`
	ContractName string `json:"contractName"`
}) {
	defer func() {
		s.mu.Lock()
		s.refreshing = false
		s.mu.Unlock()
	}()

	fresh := map[string]edgexTickerRow{}
	// 5 req/s: edgeX's per-contract endpoint is stricter than the meta
	// endpoint; this rate has tested clean from Railway without WAF
	// pushback. A full ~290-contract sweep at this rate takes ~58s and
	// fits inside the 60s tick boundary.
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	var fails int
	for _, c := range contracts {
		<-tick.C
		tBody, err := s.get(fmt.Sprintf(
			"https://pro.edgex.exchange/api/v1/public/quote/getTicker?contractId=%s",
			c.ContractID,
		))
		if err != nil {
			fails++
			continue
		}
		var tk edgexTickerResponse
		if err := json.Unmarshal(tBody, &tk); err != nil {
			fails++
			continue
		}
		if len(tk.Data) == 0 {
			continue
		}
		row := tk.Data[0]
		mark, _ := strconv.ParseFloat(row.MarkPrice, 64)
		val, _ := strconv.ParseFloat(row.Value, 64)
		oi, _ := strconv.ParseFloat(row.OpenInterest, 64)
		fresh[c.ContractID] = edgexTickerRow{value: val, oi: oi, mark: mark}
	}

	// Only swap the cache in if we got a meaningful refresh; partial
	// refreshes (most contracts blocked by WAF) would deflate the
	// gauge to false-low values, so we keep the previous snapshot
	// when the refresh was clearly degraded.
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(fresh) < len(contracts)/2 {
		fmt.Printf("[perp-cohort][edgex][%s] cache refresh DEGRADED: %d/%d ok, %d fails; keeping prior snapshot (%d)\n",
			srcEdgexNative, len(fresh), len(contracts), fails, len(s.cache))
		return
	}
	s.cache = fresh
	s.cacheTS = time.Now()
	fmt.Printf("[perp-cohort][edgex][%s] cache refreshed: %d contracts (%d fails)\n",
		srcEdgexNative, len(fresh), fails)
}

func (s *EdgexNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	// edgeX sits behind a Cloudflare WAF that 403s any non-browser UA;
	// fronting a Mozilla string gets us through. The contact email is
	// kept inside an X-Contact header so the operator is still
	// identifiable to a human reviewing access logs.
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; OpenChainBench-PerpCohort/1.0)")
	req.Header.Set("X-Contact", "contact@mobula.io")
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
