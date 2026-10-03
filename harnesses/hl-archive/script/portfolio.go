// portfolio.go — per-account PnL from the info API, and the one number
// the published leaderboard cannot give you.
//
// `POST /info {"type":"portfolio","user":"0x…"}` answers with eight
// windows: day / week / month / allTime and a perp-only mirror of each.
// Every window carries `pnlHistory` and `accountValueHistory` as
// [millis, value] pairs, back to the account's first deposit (2024-01-24
// on the account probed while designing this).
//
// Two consequences worth stating, because both correct an assumption we
// started from:
//
//   - the history already exists. The leaderboard is a snapshot, so the
//     obvious plan was to archive it daily and wait two months for a
//     persistence series. Unnecessary: `allTime` ships ~90 points per
//     account, `month` ~47 at 16 h granularity. Rank persistence is
//     computable on day one.
//   - the perp/non-perp split is published, not inferred. Reading
//     `perpAllTime` against `allTime` gives, per account, the share of
//     lifetime PnL that did not come from perps. On the account probed
//     on 2026-10-03 that was $36.1 m of $198.9 m, 18 %, sitting in a
//     leaderboard column beside a volume field that counts perps only.
package script

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"
)

// portfolioWindow is one window of the info API response.
type portfolioWindow struct {
	AccountValueHistory [][2]json.RawMessage `json:"accountValueHistory"`
	PnLHistory          [][2]json.RawMessage `json:"pnlHistory"`
}

// PortfolioSample is what we keep per account: the latest point of the
// two lifetime series. The full history stays on the wire for now; the
// persistence measurement reads it in a follow-up and does not change
// this shape.
type PortfolioSample struct {
	Address string  `json:"address"`
	PnL     float64 `json:"pnl_usd"`
	PerpPnL float64 `json:"perp_pnl_usd"`
	Equity  float64 `json:"equity_usd"`
}

// NonPerpPnL is the part of lifetime PnL the perp window does not claim:
// spot, vault deposits (HLP), staking. Can be negative when perps carried
// the account and the rest lost, which is itself worth seeing.
func (p PortfolioSample) NonPerpPnL() float64 { return p.PnL - p.PerpPnL }

// lastValue reads the final value of a [millis, value] series. The value
// is published as a JSON string; a series that is empty or unparseable
// yields 0, false so callers can tell "no data" from "zero".
func lastValue(series [][2]json.RawMessage) (float64, bool) {
	if len(series) == 0 {
		return 0, false
	}
	var s string
	if err := json.Unmarshal(series[len(series)-1][1], &s); err != nil {
		return 0, false
	}
	v := parseFloat(s)
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// FetchPortfolio asks the info API for one account.
func FetchPortfolio(ctx context.Context, client *http.Client, addr string) (PortfolioSample, error) {
	body, err := json.Marshal(map[string]string{"type": "portfolio", "user": addr})
	if err != nil {
		return PortfolioSample{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, InfoAPIURL, bytes.NewReader(body))
	if err != nil {
		return PortfolioSample{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := client.Do(req)
	if err != nil {
		return PortfolioSample{}, fmt.Errorf("portfolio post: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return PortfolioSample{}, fmt.Errorf("portfolio http %d", resp.StatusCode)
	}
	return ParsePortfolio(addr, resp.Body)
}

// ParsePortfolio decodes the [name, window] pair array.
func ParsePortfolio(addr string, r io.Reader) (PortfolioSample, error) {
	var raw [][]json.RawMessage
	if err := json.NewDecoder(r).Decode(&raw); err != nil {
		return PortfolioSample{}, fmt.Errorf("decode portfolio: %w", err)
	}
	out := PortfolioSample{Address: addr}
	var seen bool
	for _, pair := range raw {
		if len(pair) != 2 {
			continue
		}
		var name string
		if err := json.Unmarshal(pair[0], &name); err != nil {
			continue
		}
		if name != "allTime" && name != "perpAllTime" {
			continue
		}
		var w portfolioWindow
		if err := json.Unmarshal(pair[1], &w); err != nil {
			continue
		}
		pnl, ok := lastValue(w.PnLHistory)
		if !ok {
			continue
		}
		switch name {
		case "allTime":
			out.PnL = pnl
			seen = true
			if eq, ok := lastValue(w.AccountValueHistory); ok {
				out.Equity = eq
			}
		case "perpAllTime":
			out.PerpPnL = pnl
		}
	}
	if !seen {
		return PortfolioSample{}, fmt.Errorf("portfolio carried no allTime window")
	}
	return out, nil
}

// Decomposition aggregates a sample into the published figure.
type Decomposition struct {
	Sampled    int     `json:"sampled"`
	Failed     int     `json:"failed"`
	PnL        float64 `json:"pnl_usd"`
	PerpPnL    float64 `json:"perp_pnl_usd"`
	NonPerpPnL float64 `json:"non_perp_pnl_usd"`
	NonPerpPct float64 `json:"non_perp_pnl_pct"`
	// WithNonPerp counts accounts where the two windows disagree by more
	// than a dollar. A count, not a share of dollars, so one whale
	// cannot carry the finding on its own.
	WithNonPerp int `json:"accounts_with_non_perp_pnl"`
}

// Decompose folds samples into the aggregate split.
func Decompose(samples []PortfolioSample, failed int) Decomposition {
	d := Decomposition{Sampled: len(samples), Failed: failed}
	for _, s := range samples {
		d.PnL += s.PnL
		d.PerpPnL += s.PerpPnL
		if math.Abs(s.NonPerpPnL()) > 1 {
			d.WithNonPerp++
		}
	}
	d.NonPerpPnL = d.PnL - d.PerpPnL
	d.NonPerpPct = pct(d.NonPerpPnL, d.PnL)
	return d
}

// SamplePortfolios walks addresses at a fixed request rate.
//
// Paced deliberately: the info API is weight-limited per IP and this is a
// courtesy read of a public endpoint, not a right. A failed account is
// counted and skipped rather than retried, because the aggregate is a
// share and one missing row moves it less than a stalled sweep would.
func SamplePortfolios(ctx context.Context, client *http.Client, addrs []string, perSecond float64) (Decomposition, []PortfolioSample) {
	if perSecond <= 0 {
		perSecond = 5
	}
	tick := time.NewTicker(time.Duration(float64(time.Second) / perSecond))
	defer tick.Stop()

	samples := make([]PortfolioSample, 0, len(addrs))
	var failed int
	for _, addr := range addrs {
		select {
		case <-ctx.Done():
			Log.Warn("portfolio sweep cut short", "done", len(samples), "of", len(addrs))
			return Decompose(samples, failed), samples
		case <-tick.C:
		}
		s, err := FetchPortfolio(ctx, client, addr)
		if err != nil {
			failed++
			MetricTradersPortfolioErrors.Inc()
			continue
		}
		samples = append(samples, s)
	}
	return Decompose(samples, failed), samples
}
