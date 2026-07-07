package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Blockscout. Fully keyless.
//
// registered: GET chains.blockscout.com/api/chains — the Chainscout
//             registry, a machine-readable dict keyed by chain id
//             with explorer URLs and a hostedBy label. Mainnets only.
// verified:   for every registered mainnet, GET
//             {instance}/api/v2/blocks?type=block and gate on
//             items[0].timestamp being inside the freshness window.
//             The registry is known to rot (dead DNS, chains that
//             migrated away), which is exactly what the
//             registered-vs-verified gap surfaces. Instance failures
//             are expected and never error-bucketed; only the
//             registry fetch itself can fail the cycle.
const chainscoutURL = "https://chains.blockscout.com/api/chains"

// blockscoutWorkers is the sweep concurrency. Every probe hits a
// DISTINCT host, so there is no shared rate limit to respect; 8
// workers keep a ~460-instance sweep under 2 minutes while staying
// polite per host.
const blockscoutWorkers = 8

type chainscoutEntry struct {
	Name      string `json:"name"`
	IsTestnet bool   `json:"isTestnet"`
	Explorers []struct {
		URL      string `json:"url"`
		HostedBy string `json:"hostedBy"`
	} `json:"explorers"`
}

func probeBlockscout(_ string) coverage {
	cov := coverage{registered: -1, registeredSource: "registry", verified: -1, verifiedStrict: -1, top50: -1}
	var total time.Duration

	raw, el, err := doCall("blockscout", "GET", chainscoutURL, map[string]string{"Accept": "application/json"}, nil)
	total += el
	if err != nil {
		recordError("blockscout", err)
		fmt.Printf("[blockscout] chainscout registry failed: %v\n", err)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	mainnets, perr := parseChainscout(raw)
	if perr != nil {
		recordError("blockscout", perr)
		fmt.Printf("[blockscout] chainscout parse failed: %v\n", perr)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	cov.registered = len(mainnets)

	type job struct {
		chainID int64
		name    string
		url     string
	}
	jobs := make(chan job)
	var mu sync.Mutex
	evmLive := map[int64]bool{}
	nameLive := map[string]bool{}
	var liveCount, deadCount, strictCount int64
	var latAcc int64

	var wg sync.WaitGroup
	for w := 0; w < blockscoutWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				raw, el, err := doCallOnce("blockscout", "GET", j.url+"/api/v2/blocks?type=block", map[string]string{"Accept": "application/json"}, nil)
				atomic.AddInt64(&latAcc, el.Milliseconds())
				if err != nil {
					// Registry rot or dead instance: expected, this
					// IS the measurement. Not error-bucketed.
					atomic.AddInt64(&deadCount, 1)
					continue
				}
				ts, perr := parseBlockscoutLatestBlock(raw)
				if perr != nil {
					atomic.AddInt64(&deadCount, 1)
					continue
				}
				if !freshEnough(ts) {
					// Quiet-chain second chance: on-demand block
					// producers can be healthy yet silent for hours.
					// The instance's own average_block_time decides:
					// stale only when the age also exceeds 10x the
					// chain's own cadence.
					if !blockscoutQuietOK(j.url, ts) {
						atomic.AddInt64(&deadCount, 1)
						continue
					}
				}
				if freshStrict(ts) {
					atomic.AddInt64(&strictCount, 1)
				}
				atomic.AddInt64(&liveCount, 1)
				mu.Lock()
				if j.chainID != 0 {
					evmLive[j.chainID] = true
				}
				nameLive[normalizeChainName(j.name)] = true
				mu.Unlock()
				time.Sleep(200 * time.Millisecond)
			}
		}()
	}
	for id, e := range mainnets {
		url := pickBlockscoutURL(e)
		if url == "" {
			continue
		}
		cid, _ := strconv.ParseInt(id, 10, 64)
		jobs <- job{chainID: cid, name: e.Name, url: url}
	}
	close(jobs)
	wg.Wait()

	cov.verified = int(liveCount)
	cov.verifiedStrict = int(strictCount)
	cov.top50 = top50Count(evmLive, nameLive)
	total += time.Duration(latAcc) * time.Millisecond
	fmt.Printf("[blockscout] sweep: %d live, %d dead/stale of %d registered mainnets\n",
		liveCount, deadCount, len(mainnets))
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// blockscoutQuietOK gives a stale-looking chain a second chance: it
// reads the instance's own average_block_time from /api/v2/stats and
// accepts the chain when the last block's age is under 10x its own
// cadence (an on-demand rollup with hourly blocks is healthy at 60m
// of silence; an Ethereum instance 60m behind is broken).
func blockscoutQuietOK(url string, latest time.Time) bool {
	raw, _, err := doCallOnce("blockscout", "GET", url+"/api/v2/stats", map[string]string{"Accept": "application/json"}, nil)
	if err != nil {
		return false
	}
	var resp struct {
		AverageBlockTime float64 `json:"average_block_time"`
	}
	if json.Unmarshal(raw, &resp) != nil || resp.AverageBlockTime <= 0 {
		return false
	}
	avg := time.Duration(resp.AverageBlockTime) * time.Millisecond
	if resp.AverageBlockTime < 1000 {
		// Some instances report seconds, not milliseconds.
		avg = time.Duration(resp.AverageBlockTime * float64(time.Second))
	}
	return time.Since(latest) <= 10*avg
}

// pickBlockscoutURL prefers the Blockscout-hosted instance when one
// exists (near-100% uptime stratum), else the first listed explorer.
func pickBlockscoutURL(e chainscoutEntry) string {
	for _, x := range e.Explorers {
		if x.HostedBy == "blockscout" && x.URL != "" {
			return trimSlash(x.URL)
		}
	}
	for _, x := range e.Explorers {
		if x.URL != "" {
			return trimSlash(x.URL)
		}
	}
	return ""
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

// parseChainscout returns the mainnet entries keyed by chain id.
func parseChainscout(raw []byte) (map[string]chainscoutEntry, error) {
	var all map[string]chainscoutEntry
	if err := json.Unmarshal(raw, &all); err != nil {
		return nil, fmt.Errorf("parse chainscout: %w", err)
	}
	if len(all) == 0 {
		return nil, fmt.Errorf("parse chainscout: empty registry")
	}
	out := map[string]chainscoutEntry{}
	for id, e := range all {
		if e.IsTestnet {
			continue
		}
		out[id] = e
	}
	return out, nil
}

// parseBlockscoutLatestBlock reads items[0].timestamp (ISO 8601).
func parseBlockscoutLatestBlock(raw []byte) (time.Time, error) {
	var resp struct {
		Items []struct {
			Timestamp string `json:"timestamp"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return time.Time{}, fmt.Errorf("parse blocks: %w", err)
	}
	if len(resp.Items) == 0 || resp.Items[0].Timestamp == "" {
		return time.Time{}, fmt.Errorf("parse blocks: no items")
	}
	t, err := time.Parse(time.RFC3339, resp.Items[0].Timestamp)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse blocks timestamp: %w", err)
	}
	return t, nil
}
