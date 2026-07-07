package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"time"
)

// Subscan (Substrate ecosystem). Free self-serve key required for
// data calls (5 rps free tier); the network enumeration itself is
// keyless.
//
// registered: Subscan publishes no machine-readable network list, so
//             the harness extracts the {network}.api.subscan.io
//             subdomains from their own API support page. Exported
//             with registered_source="pinned" because it is scraped
//             from documentation, not a purpose-built registry.
// verified:   per network, POST /api/v2/scan/blocks {"row":1,"page":0}
//             with X-API-Key and gate blocks[0].block_timestamp (unix
//             seconds) on the freshness window.
const (
	subscanDocsURL = "https://support.subscan.io/doc-361776"
)

var subscanHostRe = regexp.MustCompile(`([a-z0-9-]+)\.api\.subscan\.io`)

func probeSubscan(keyIgnored string) coverage {
	key := envDefault("SUBSCAN_API_KEY", "")
	_ = keyIgnored
	cov := coverage{registered: -1, registeredSource: "pinned", verified: -1, top50: -1}
	var total time.Duration

	raw, el, err := doCall("subscan", "GET", envDefault("SUBSCAN_DOCS_URL", subscanDocsURL), map[string]string{"Accept": "text/html"}, nil)
	total += el
	if err != nil {
		recordError("subscan", err)
		fmt.Printf("[subscan] network enumeration failed: %v\n", err)
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	nets := parseSubscanNetworks(raw)
	if len(nets) == 0 {
		recordError("subscan", fmt.Errorf("parse networks: none found in docs page"))
		fmt.Printf("[subscan] no networks found in docs page\n")
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}
	cov.registered = len(nets)

	if key == "" {
		// Keyless mode: network enumeration needs no auth, data calls
		// do. Publish registered, leave verified unknown.
		fmt.Printf("[subscan] no SUBSCAN_API_KEY: publishing registered only (%d networks)\n", len(nets))
		cov.latencyMs = float64(total.Milliseconds())
		return cov
	}

	nameLive := map[string]bool{}
	verified := 0
	anyOK := false
	quotaHit := false
	body := []byte(`{"row":1,"page":0}`)
	for _, net := range nets {
		time.Sleep(sweepSpacing)
		url := fmt.Sprintf("https://%s.api.subscan.io/api/v2/scan/blocks", net)
		raw, el, err := doCall("subscan", "POST", url, map[string]string{
			"X-API-Key":    key,
			"Content-Type": "application/json",
		}, body)
		total += el
		if err != nil {
			if isQuotaStatus(httpStatus(err)) {
				quotaHit = true
				recordError("subscan", err)
				continue
			}
			anyOK = true // dead network endpoint: definitive
			continue
		}
		ts, perr := parseSubscanLatestBlock(raw)
		anyOK = true
		if perr == nil && freshEnough(ts) {
			verified++
			nameLive[normalizeChainName(net)] = true
		}
	}

	if quotaHit {
		fmt.Printf("[subscan] quota-class failures during cycle, publishing nothing\n")
		cov.registered, cov.verified, cov.top50 = -1, -1, -1
	} else if anyOK {
		cov.verified = verified
		cov.top50 = top50Count(map[int64]bool{}, nameLive)
	}
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// parseSubscanNetworks extracts unique network subdomains from the
// support page HTML, sorted for stable probe order.
func parseSubscanNetworks(raw []byte) []string {
	seen := map[string]bool{}
	for _, m := range subscanHostRe.FindAllSubmatch(raw, -1) {
		n := string(m[1])
		// "pro" and "www"-style artifacts are not networks.
		if n == "pro" || n == "www" || n == "support" {
			continue
		}
		seen[n] = true
	}
	out := make([]string, 0, len(seen))
	for n := range seen {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// parseSubscanLatestBlock reads data.blocks[0].block_timestamp (unix
// seconds).
func parseSubscanLatestBlock(raw []byte) (time.Time, error) {
	var resp struct {
		Data struct {
			Blocks []struct {
				BlockTimestamp int64 `json:"block_timestamp"`
			} `json:"blocks"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return time.Time{}, fmt.Errorf("parse blocks: %w", err)
	}
	if len(resp.Data.Blocks) == 0 || resp.Data.Blocks[0].BlockTimestamp == 0 {
		return time.Time{}, fmt.Errorf("parse blocks: no items")
	}
	return time.Unix(resp.Data.Blocks[0].BlockTimestamp, 0), nil
}
