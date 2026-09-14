package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Source produces UTC-day perp volume for one venue. Daily returns every
// day it can fill inside [from, to] (inclusive); missing days are simply
// absent, never zero, so a source outage leaves holes rather than false
// lows. Sources mirror DeFiLlama's dimension-adapters for the venue
// (path noted on each type) so the numbers line up with defillama.com
// on closed days.
type Source interface {
	// Slug is the OCB provider slug (bench label venue="<slug>").
	Slug() string
	// DisplayName is the venue name on the public JSON.
	DisplayName() string
	// Name identifies the upstream (gmx-squid, gains-backend, defillama-pro...).
	Name() string
	// Note is a one-line perimeter caveat for the public JSON.
	Note() string
	// Start is the first day the source has data for.
	Start() time.Time
	Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error)
}

type venueMeta struct {
	slug, name, llamaSlug string
	start                 time.Time
}

func day(s string) time.Time {
	t, err := parseDay(s)
	if err != nil {
		panic(err)
	}
	return t
}

// cohort is the ordered venue list. llamaSlug is the DeFiLlama
// derivatives slug used when DEFILLAMA_API_KEY is set. Start dates are
// the adapters' own start fields.
var cohort = []venueMeta{
	{"hyperliquid", "Hyperliquid", "hyperliquid-perps", day("2023-06-13")},
	{"gmx", "GMX V2", "gmx-v2-perps", day("2023-08-01")},
	{"gains", "Gains Network", "gains-network", day("2023-05-25")},
	{"aster", "Aster", "aster-perps", day("2024-10-01")},
	{"lighter", "Lighter", "lighter-perps", day("2025-01-17")},
	{"dydx", "dYdX v4", "dydx-v4", day("2023-10-26")},
	{"paradex", "Paradex", "paradex-perps", day("2023-09-01")},
	{"extended", "Extended", "extended-perps", day("2025-03-11")},
	{"orderly", "Orderly", "orderly-perps", day("2023-10-26")},
	{"aevo", "Aevo", "aevo-perps", day("2023-04-14")},
}

// buildSources wires one source per cohort venue. With a DeFiLlama Pro
// key every venue reads the Pro API (the reference number); otherwise
// each venue reads the upstream its DeFiLlama adapter reads. Gains gets
// the Dune view DeFiLlama reads when DUNE_API_KEY is set, the Gains
// backend otherwise.
func buildSources(llamaKey string) []Source {
	out := make([]Source, 0, len(cohort))
	for _, v := range cohort {
		if llamaKey != "" {
			out = append(out, &llamaProSource{meta: v, key: llamaKey})
			continue
		}
		switch v.slug {
		case "hyperliquid":
			out = append(out, &hyperliquidSource{meta: v})
		case "gmx":
			out = append(out, &gmxSource{meta: v})
		case "gains":
			out = append(out, newGainsSource(v))
		case "aster":
			out = append(out, &asterSource{meta: v})
		case "lighter":
			out = append(out, &lighterSource{meta: v})
		case "dydx":
			out = append(out, &dydxSource{meta: v})
		case "paradex":
			out = append(out, &paradexSource{meta: v})
		case "extended":
			out = append(out, &extendedSource{meta: v})
		case "orderly":
			out = append(out, &orderlySource{meta: v})
		case "aevo":
			out = append(out, &aevoSource{meta: v})
		}
	}
	return out
}

// ---------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------

var httpClient = &http.Client{Timeout: 45 * time.Second}

const userAgent = "OpenChainBench-PerpVolumeHistory/1.0 contact@openchainbench.com"

func getJSON(ctx context.Context, url string, out any) error {
	return doJSON(ctx, http.MethodGet, url, nil, nil, out)
}

func postJSON(ctx context.Context, url string, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return doJSON(ctx, http.MethodPost, url, b, nil, out)
}

// doJSONHeaders is postJSON/getJSON with extra request headers (API keys).
func doJSONHeaders(ctx context.Context, method, url string, body any, headers map[string]string, out any) error {
	var b []byte
	if body != nil {
		var err error
		if b, err = json.Marshal(body); err != nil {
			return err
		}
	}
	return doJSON(ctx, method, url, b, headers, out)
}

func doJSON(ctx context.Context, method, url string, body []byte, headers map[string]string, out any) error {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt*attempt) * 2 * time.Second):
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		resp.Body.Close()
		if resp.StatusCode == 429 || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("status_%d", resp.StatusCode)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(raw), 160))
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("parse: %w (%s)", err, truncate(string(raw), 120))
		}
		return nil
	}
	return lastErr
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// inRange reports whether d (a UTC midnight) lies in [from, to].
func inRange(d, from, to time.Time) bool {
	return !d.Before(from) && !d.After(to)
}

// eachDay calls fn for every day in [from, to] in ascending order,
// stopping on context cancellation.
func eachDay(ctx context.Context, from, to time.Time, fn func(d time.Time) error) error {
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := fn(d); err != nil {
			return err
		}
	}
	return nil
}

// throttle sleeps so that per-venue sources stay under a requests per
// minute ceiling without a token-bucket dependency.
type throttle struct {
	interval time.Duration
	last     time.Time
}

func newThrottle(perMinute int) *throttle {
	return &throttle{interval: time.Minute / time.Duration(perMinute)}
}

func (t *throttle) wait(ctx context.Context) error {
	if wait := t.interval - time.Since(t.last); wait > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	t.last = time.Now()
	return nil
}

// ---------------------------------------------------------------------
// DeFiLlama Pro (all venues, when keyed)
// ---------------------------------------------------------------------

// llamaProSource reads GET https://pro-api.llama.fi/<key>/api/summary/derivatives/<slug>?dataType=dailyVolume
// which carries the whole totalDataChart. One call per venue per sweep.
type llamaProSource struct {
	meta venueMeta
	key  string
}

func (s *llamaProSource) Slug() string        { return s.meta.slug }
func (s *llamaProSource) DisplayName() string { return s.meta.name }
func (s *llamaProSource) Name() string        { return "defillama-pro" }
func (s *llamaProSource) Note() string        { return "DeFiLlama derivatives dailyVolume (Pro API)" }
func (s *llamaProSource) Start() time.Time    { return s.meta.start }

func (s *llamaProSource) Daily(ctx context.Context, from, to time.Time) (map[time.Time]float64, error) {
	var resp struct {
		TotalDataChart [][2]float64 `json:"totalDataChart"`
	}
	url := fmt.Sprintf("https://pro-api.llama.fi/%s/api/summary/derivatives/%s?dataType=dailyVolume", s.key, s.meta.llamaSlug)
	if err := getJSON(ctx, url, &resp); err != nil {
		return nil, err
	}
	out := map[time.Time]float64{}
	for _, p := range resp.TotalDataChart {
		d := utcDay(time.Unix(int64(p[0]), 0))
		if inRange(d, from, to) {
			out[d] = p[1]
		}
	}
	return out, nil
}
