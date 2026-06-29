package main

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// fieldOrder is the canonical 5-field order used everywhere we render a
// condensed line. Keep this in sync with the YAML bench spec.
var fieldOrder = []string{"name", "image", "description", "floor_eth", "external_url"}

// truncate clips a string to n chars, appending "..." if cut. Used to keep
// error logs compact when an upstream returns a multi-line HTML body.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// providerOrder is the column order in the condensed line, log table, and
// any debug dump.
var providerOrder = []string{"moralis", "alchemy", "opensea", "rarible"}

// fieldLetter maps each field to a single-letter code (NIDFE) used in the
// condensed per-collection log line.
var fieldLetter = map[string]string{
	"name":         "N",
	"image":        "I",
	"description":  "D",
	"floor_eth":    "F",
	"external_url": "E",
}

// classifyHTTPStatus buckets a status code into the error_type label space.
// 429 gets its own bucket because it's the only error we'd actually rate-
// limit ourselves against; 4xx vs 5xx separation lets us tell venue bugs
// from our bugs.
func classifyHTTPStatus(status int) string {
	switch {
	case status == 429:
		return "throttled"
	case status == 404:
		return "not_found"
	case status >= 500:
		return "http_5xx"
	case status >= 400:
		return "http_4xx"
	default:
		return fmt.Sprintf("http_%d", status)
	}
}

// classifyNetError reduces the long tail of transport errors to 3 buckets so
// the Prom label space stays bounded. Anything that smells like a deadline is
// "timeout", reset connections are "net_error", everything else stays as
// "request_error".
func classifyNetError(err error) string {
	if err == nil {
		return ""
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	msg := err.Error()
	if strings.Contains(msg, "connection reset") || strings.Contains(msg, "EOF") {
		return "net_error"
	}
	return "request_error"
}

// raribleThrottle enforces the 1 req/sec ceiling the validation harness
// observed. Implemented as a simple time-since-last-call guard because we
// have exactly one Rarible worker goroutine (serial loop in monitor.go).
var (
	raribleLastReqMu sync.Mutex
	raribleLastReq   time.Time
)

func raribleWaitTurn() {
	raribleLastReqMu.Lock()
	now := time.Now()
	since := now.Sub(raribleLastReq)
	if since < time.Second {
		wait := time.Second - since
		raribleLastReqMu.Unlock()
		time.Sleep(wait)
		raribleLastReqMu.Lock()
	}
	raribleLastReq = time.Now()
	raribleLastReqMu.Unlock()
}

// openSeaThrottle enforces ~1 call per 650ms. OpenSea allows 60 req/min and
// we issue 2 calls per collection, so a 650ms gap keeps us under the cap
// even when both calls land. The harness is single-goroutine for OS, so
// global state is fine.
var (
	openSeaLastReqMu sync.Mutex
	openSeaLastReq   time.Time
)

func openSeaWaitTurn() {
	openSeaLastReqMu.Lock()
	now := time.Now()
	since := now.Sub(openSeaLastReq)
	const gap = 650 * time.Millisecond
	if since < gap {
		wait := gap - since
		openSeaLastReqMu.Unlock()
		time.Sleep(wait)
		openSeaLastReqMu.Lock()
	}
	openSeaLastReq = time.Now()
	openSeaLastReqMu.Unlock()
}

// resolveAllSlugs walks every collection at startup and replaces the seed
// slug with the canonical OpenSea slug. Failures are logged and the seed
// slug is kept (likely to fail later on /collections/{slug}, but at least
// the other 3 providers still run).
func resolveAllSlugs(colls []NFTCollection, cfg *Config) []NFTCollection {
	out := make([]NFTCollection, len(colls))
	for i, c := range colls {
		openSeaWaitTurn()
		slug, err := resolveOpenSeaSlug(c.Contract, cfg.OpenSeaAPIKey, cfg.MonitorRegion)
		if err != nil || slug == "" {
			fmt.Printf("[NFT][slug] %s: resolve failed (%v), keeping seed=%q\n", c.Name, err, c.OpenSeaSlug)
			out[i] = c
			continue
		}
		if slug != c.OpenSeaSlug {
			fmt.Printf("[NFT][slug] %s: %q -> %q\n", c.Name, c.OpenSeaSlug, slug)
		}
		c.OpenSeaSlug = slug
		out[i] = c
	}
	return out
}

// renderFieldCode produces a 5-char letter code per provider. "N"=present,
// "."=absent, "-"=skipped (Rarible floor_eth). Order matches fieldOrder.
func renderFieldCode(provider string, fields map[string]bool) string {
	out := make([]byte, 0, len(fieldOrder))
	for _, f := range fieldOrder {
		if provider == "rarible" && f == "floor_eth" {
			out = append(out, '-')
			continue
		}
		v, ok := fields[f]
		if !ok {
			out = append(out, '.')
			continue
		}
		if v {
			out = append(out, fieldLetter[f][0])
		} else {
			out = append(out, '.')
		}
	}
	return string(out)
}

// applyResult is the single funnel that pushes a provider response into
// Prometheus. The Rarible floor_eth skip lives here (we drop the key before
// recordFieldChecks runs).
func applyResult(res NFTResult, region string) {
	if res.Provider == "rarible" {
		delete(res.Fields, "floor_eth")
	}
	if len(res.Fields) == 0 {
		// Hard failure (e.g. config error). Don't pollute the success ratio
		// — only error counters were touched at the call site.
		return
	}
	recordFieldChecks(res.Provider, res.Collection, region, res.Fields)
	bumpCycleStats(res.Provider, res.Fields)
}

// runCheckAllProviders is the per-cycle entry point. Pre-resolves OpenSea
// slugs once, then iterates the active collection list and fires the 4
// provider probes per the rate-limit plan from the spec.
func runCheckAllProviders(cfg *Config) {
	colls := activeCollections(cfg.Smoke)
	fmt.Printf("[NFT][cycle] start: %d collections, region=%s, smoke=%v\n",
		len(colls), cfg.MonitorRegion, cfg.Smoke)

	// Pre-resolve slugs (uses the openSeaWaitTurn throttle).
	colls = resolveAllSlugs(colls, cfg)

	startedAt := time.Now()
	processed := int32(0)

	for _, coll := range colls {
		results := map[string]NFTResult{}
		var mu sync.Mutex
		var wg sync.WaitGroup

		// Moralis + Alchemy in parallel — generous rate limits, no need to
		// serialize.
		wg.Add(2)
		go func() {
			defer wg.Done()
			r := checkMoralis(coll, cfg.MoralisAPIKey, cfg.MonitorRegion)
			mu.Lock()
			results["moralis"] = r
			mu.Unlock()
		}()
		go func() {
			defer wg.Done()
			r := checkAlchemy(coll, cfg.AlchemyAPIKey, cfg.MonitorRegion)
			mu.Lock()
			results["alchemy"] = r
			mu.Unlock()
		}()
		wg.Wait()

		// OpenSea is serial via openSeaWaitTurn (2 calls per collection,
		// 650ms gap between any 2 calls).
		openSeaWaitTurn() // gap before call 1
		osRes := checkOpenSea(coll, cfg.OpenSeaAPIKey, cfg.MonitorRegion)
		results["opensea"] = osRes
		openSeaWaitTurn() // accounts for the second internal call's spacing

		// Rarible is serial @ 1 req/sec.
		raribleWaitTurn()
		raRes := checkRarible(coll, cfg.RaribleAPIKey, cfg.MonitorRegion)
		results["rarible"] = raRes

		for _, p := range providerOrder {
			applyResult(results[p], cfg.MonitorRegion)
		}

		// Console-log any provider error so Railway logs surface it. The
		// recordError() calls only increment Prom counters; without this
		// echo, a silent provider failure (auth, rate-limit, network) reads
		// as "M:....." in the condensed line below with zero explanation.
		for _, p := range providerOrder {
			r := results[p]
			if r.Error != "" {
				fmt.Printf("[NFT][%s][err] %s (%s): status=%d type=%s msg=%s\n",
					p, coll.Name, coll.Contract, r.StatusCode, r.ErrorType, truncate(r.Error, 200))
			}
		}

		// Condensed per-collection log line.
		parts := make([]string, 0, len(providerOrder))
		for _, p := range providerOrder {
			r := results[p]
			letter := strings.ToUpper(p[:1])
			parts = append(parts, fmt.Sprintf("%s:%s", letter, renderFieldCode(p, r.Fields)))
		}
		fmt.Printf("[NFT] %-22s | %s\n", coll.Name, strings.Join(parts, " | "))

		n := atomic.AddInt32(&processed, 1)
		if n%10 == 0 {
			printCycleStats(colls[:n], cfg)
		}
	}

	fmt.Printf("[NFT][cycle] done: %d collections in %s\n",
		len(colls), time.Since(startedAt).Round(time.Second))
	printCycleStats(colls, cfg)
}

// printCycleStats walks the Prom counters and renders a coverage table for
// the slice provided. Reads the counter snapshot via Prometheus' gather()
// would require more plumbing; we just keep a small in-memory mirror.
//
// To avoid duplicating state, we compute totals on the fly by re-walking the
// already-emitted Prom families. That's expensive at 50 collections though,
// so we instead maintain a parallel in-process accumulator below.
var (
	statsMu sync.Mutex
	// stats[provider][field] = [success, total]
	cycleStats = map[string]map[string][2]int{}
)

func init() {
	for _, p := range providerOrder {
		cycleStats[p] = map[string][2]int{}
	}
}

// applyResult feeds Prom AND the in-memory cycle stats so we can print a
// table without scraping our own /metrics endpoint.
//
// (override of the earlier applyResult — Go allows only one definition, so
// the implementation above is the only one. Stats tracking happens inline.)

func bumpCycleStats(provider string, fields map[string]bool) {
	statsMu.Lock()
	defer statsMu.Unlock()
	for f, ok := range fields {
		cur := cycleStats[provider][f]
		cur[1]++
		if ok {
			cur[0]++
		}
		cycleStats[provider][f] = cur
	}
}

func printCycleStats(processed []NFTCollection, cfg *Config) {
	statsMu.Lock()
	defer statsMu.Unlock()
	fmt.Printf("\n--- NFT coverage snapshot (after %d collections, region=%s) ---\n",
		len(processed), cfg.MonitorRegion)
	fmt.Printf("%-10s | %-12s | %-12s | %-12s | %-12s | %-12s\n",
		"provider", "name", "image", "description", "floor_eth", "external_url")
	fmt.Printf("%s\n", strings.Repeat("-", 84))
	for _, p := range providerOrder {
		row := fmt.Sprintf("%-10s", p)
		for _, f := range fieldOrder {
			cur := cycleStats[p][f]
			if p == "rarible" && f == "floor_eth" {
				row += " | " + fmt.Sprintf("%-12s", "skipped")
				continue
			}
			if cur[1] == 0 {
				row += " | " + fmt.Sprintf("%-12s", "-")
				continue
			}
			pct := float64(cur[0]) / float64(cur[1]) * 100
			row += " | " + fmt.Sprintf("%5.1f%% %3d/%-3d", pct, cur[0], cur[1])
		}
		fmt.Println(row)
	}
	fmt.Println()
}
