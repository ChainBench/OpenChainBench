package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The public tehcscreener API, Allium-backed, no key, 120 requests a minute.
// Documented at https://tehcscreener.com/api.
//
// Why this source: benches 203, 206, 207 and 232 were gated to staging on
// 2026-10-02 when the Dune trial ended, with the note "these four have no free
// equivalent for what they measure". This is that equivalent. It is a different
// vendor, not a cheaper route to the same one: the bot and launchpad series are
// Allium-derived. The one endpoint that still carries Dune lineage is launchpad
// revenue (987 of 988 days tagged dune_seed), which this harness does not read.
const apiBase = "https://tehcscreener.com/api/v1"

// botsWindow is the window asked of the per-bot endpoint. Seven days is enough
// to find the latest day with activity and to let the freshness gate see that a
// pair has gone quiet, without pulling years of series on every cycle: the
// figures published are one day's, never the window's sum.
const botsWindow = "7d"

type apiClient struct {
	http *http.Client
	base string
}

func newAPIClient(base string, timeout time.Duration) *apiClient {
	return &apiClient{http: &http.Client{Timeout: timeout}, base: strings.TrimRight(base, "/")}
}

func (c *apiClient) getJSON(path string, out any) error {
	u := c.base + path
	if _, err := url.Parse(u); err != nil {
		return fmt.Errorf("bad url %q: %w", u, err)
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/terminal-activity (+https://openchainbench.com)")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	// 429 is called out separately because it is the one failure a caller can
	// fix by slowing down rather than by retrying, and the API documents
	// Retry-After on it.
	if resp.StatusCode == http.StatusTooManyRequests {
		return fmt.Errorf("rate limited (retry-after %q)", resp.Header.Get("Retry-After"))
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(body))[:min(200, len(body))])
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	return nil
}

// botsRoster is /bots, read only for the list of bot ids. The series it carries
// are per bot across every chain, which is not what any of these benches
// measure, so the figures come from the per-bot endpoint instead.
type botsRoster struct {
	Through string `json:"through"`
	Series  []struct {
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
	} `json:"series"`
}

// chainSeries is one chain's per-day arrays inside a botDetail. Every array is
// documented as aligned index for index with botDetail.Days.
type chainSeries struct {
	Name      string    `json:"name"`
	VolumeUSD []float64 `json:"volume_usd"`
	Txns      []float64 `json:"txns"`
	FeesUSD   []float64 `json:"fees_usd"`
	Wallets   []float64 `json:"wallets"`
}

// botDetail is /bots/{bot}: one series per chain.
type botDetail struct {
	Bot         string        `json:"bot"`
	DisplayName string        `json:"display_name"`
	Through     string        `json:"through"`
	FirstDay    string        `json:"first_day"`
	Days        []string      `json:"days"`
	Series      []chainSeries `json:"series"`
}

func (c *apiClient) roster() ([]string, error) {
	var r botsRoster
	// window=all so a bot that has gone quiet is still in the roster and can be
	// published as unhealthy rather than silently vanishing. BullX is the case:
	// 765 days of history, $25.6B lifetime, and no volume since 2026-05-31.
	// A roster read over 30d drops it, and a row that disappears reads on the
	// board exactly like a row that was never offered.
	if err := c.getJSON("/bots?window=all&group=bot", &r); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(r.Series))
	for _, s := range r.Series {
		if s.Name != "" {
			out = append(out, s.Name)
		}
	}
	return out, nil
}

func (c *apiClient) bot(id string) (*botDetail, error) {
	var d botDetail
	if err := c.getJSON("/bots/"+url.PathEscape(id)+"?window="+botsWindow, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// sample is one platform on one chain for one UTC day: the unit every gauge in
// this harness describes.
type sample struct {
	Platform string
	Chain    string
	Day      string // YYYY-MM-DD
	DayUnix  float64
	Volume   float64
	Txns     float64
	Fees     float64
	Wallets  float64
}

// latestSamples reduces a bot's per-chain series to one sample per chain, taken
// on the API's own latest day rather than on the latest day that happens to
// carry a number.
//
// Walking back to the last non-zero day would be the wrong kindness. A bench
// answering "active wallets in 24h" has to read empty for a platform that did
// nothing in those 24 hours, and basedbot is exactly that case: $419M on
// Robinhood against $15.8M on Solana over 30 days, and zero Solana volume in
// the last 7. Carrying its last live Solana day forward would publish a
// Robinhood bot as a Solana participant.
//
// A pair with no activity on the day returns no sample, and the caller drops it.
func latestSamples(d *botDetail) []sample {
	if d == nil || len(d.Days) == 0 {
		return nil
	}
	i := len(d.Days) - 1
	day := d.Days[i]
	dayUnix, err := dayToUnix(day)
	if err != nil {
		return nil
	}
	out := make([]sample, 0, len(d.Series))
	for _, s := range d.Series {
		if s.Name == "" {
			continue
		}
		v := at(s.VolumeUSD, i)
		t := at(s.Txns, i)
		// Volume and transactions both have to be there. One without the other
		// is a half-loaded day, and every derived figure on this harness is a
		// ratio of two of these fields: publishing a zero denominator is how a
		// division becomes an infinity on a public page.
		if v <= 0 || t <= 0 {
			continue
		}
		out = append(out, sample{
			Platform: d.Bot,
			Chain:    s.Name,
			Day:      day,
			DayUnix:  dayUnix,
			Volume:   v,
			Txns:     t,
			Fees:     at(s.FeesUSD, i),
			Wallets:  at(s.Wallets, i),
		})
	}
	return out
}

// at is a bounds-safe read of a per-day array. The API documents every series
// array as aligned to `days`, but a short array would otherwise panic the
// harness on a shape change, and v1 is additive-only about fields, not about
// lengths.
func at(xs []float64, i int) float64 {
	if i < 0 || i >= len(xs) {
		return 0
	}
	return xs[i]
}

func dayToUnix(day string) (float64, error) {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return 0, err
	}
	return float64(t.UTC().Unix()), nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
