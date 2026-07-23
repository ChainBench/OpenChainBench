package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Shared HTTP helpers for the NAV-appreciation model probes (BENJI,
// OUSG). These tokens report their NAV (share price) via an off-chain
// issuer API rather than emitting on-chain distribution events.
// Delivered yield is computed from NAV growth across the window:
//
//     yield = (NAV(t=now) - NAV(t=window ago)) / NAV(t=window ago)
//             * (365 / window_days)
//
// Since we don't get NAV(t=window ago) from the issuer API directly
// in V1 (most issuers only expose the current NAV), we bootstrap by
// storing our own daily NAV snapshots in memory. The 30d and 7d
// delivered yields only become available after the harness has been
// running for the corresponding window. Until then, the probe reports
// zero for that window; the "sample_size" / probe_ok labels signal
// this to the site so the row is dimmed rather than shown as a real
// zero.
//
// V2 will replace the in-memory ring with the on-chain oracle where
// one exists (Chainlink PoR for BUIDL, native oracle for BENJI's
// FOBXX proxy), removing the warmup dependency.

var navHTTPClient = &http.Client{Timeout: httpTimeout}

// fetchJSONNumber makes a GET to `url`, parses the response as JSON,
// and extracts a numeric value at the given JSON path (dot-separated).
// Returns the value as float64. Fails cleanly if the field is missing
// or non-numeric, so a schema change at the issuer surfaces as a probe
// error rather than a silent zero.
func fetchJSONNumber(url string, jsonPath []string) (float64, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "openchainbench-rwa-yield-probe/1.0")
	resp, err := navHTTPClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("nav source: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("nav source: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MiB cap
	if err != nil {
		return 0, err
	}
	var doc any
	if err := json.Unmarshal(body, &doc); err != nil {
		return 0, fmt.Errorf("nav source: parse %w", err)
	}
	cur := doc
	for _, seg := range jsonPath {
		obj, ok := cur.(map[string]any)
		if !ok {
			return 0, fmt.Errorf("nav source: expected object at path segment %q", seg)
		}
		cur, ok = obj[seg]
		if !ok {
			return 0, fmt.Errorf("nav source: missing field %q", seg)
		}
	}
	switch v := cur.(type) {
	case float64:
		return v, nil
	case string:
		var f float64
		if _, err := fmt.Sscanf(v, "%f", &f); err != nil {
			return 0, fmt.Errorf("nav source: non-numeric string at path")
		}
		return f, nil
	default:
		return 0, fmt.Errorf("nav source: value is %T, want number", cur)
	}
}

// navRingSample is one daily NAV snapshot kept in memory to enable
// windowed yield computation without waiting for the issuer to expose
// historical NAV via API.
type navRingSample struct {
	At  time.Time
	NAV float64
}

// navRing is a bounded circular buffer of daily NAV snapshots, one
// per token. Ships as much as 30 days of history (72 samples at 10-hour
// intervals is plenty for the 30d window computation). Older samples
// are evicted automatically as new ones arrive.
type navRing struct {
	samples []navRingSample
	max     int
}

func newNavRing(max int) *navRing {
	return &navRing{samples: make([]navRingSample, 0, max), max: max}
}

func (r *navRing) push(now time.Time, nav float64) {
	r.samples = append(r.samples, navRingSample{At: now, NAV: nav})
	if len(r.samples) > r.max {
		r.samples = r.samples[len(r.samples)-r.max:]
	}
}

// navAt returns the NAV sample closest to `target`, or zero if the
// ring has no data covering that timestamp (i.e. token was added
// less than `target ago`).
func (r *navRing) navAt(target time.Time) float64 {
	if len(r.samples) == 0 {
		return 0
	}
	// Linear scan (ring is small, ~72 entries).
	var best navRingSample
	var bestDelta time.Duration = 1<<62 - 1
	for _, s := range r.samples {
		d := s.At.Sub(target)
		if d < 0 {
			d = -d
		}
		if d < bestDelta {
			bestDelta = d
			best = s
		}
	}
	// If the closest sample is more than 2 days off the target we
	// don't have coverage — return zero.
	if bestDelta > 48*time.Hour {
		return 0
	}
	return best.NAV
}
