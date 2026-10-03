// traders.go — the trader side of the Hyperliquid archive.
//
// Hyperliquid publishes its own trader leaderboard as a single public
// blob: `stats-data.hyperliquid.xyz/Mainnet/leaderboard`, ~39 MB, no key,
// ~47k accounts, each carrying PnL / ROI / volume over day, week, month
// and allTime plus current equity.
//
// We do not reproduce that table. The venue already renders it, and a
// copy would say nothing new. What is missing is an audit, because three
// properties of the published blob contradict each other and the page
// offers no way to see it:
//
//   - `pnl` and `vlm` sit in the same row and count different universes.
//     `vlm` is perp notional; `pnl` absorbs spot, vaults and staking too.
//     On the first full read (2026-10-03) 2,898 accounts published a
//     non-zero PnL against exactly zero all-time volume, worth $5.29 bn,
//     32 % of the leaderboard's aggregate PnL.
//   - the aggregate is strongly positive (+$16.53 bn across 47,107
//     accounts, 51.2 % of them in profit). Perp PnL is zero-sum between
//     longs and shorts net of fees, so a positive aggregate is proof the
//     published set is not the population: the losers are absent. Spot
//     and HLP yield are genuinely not zero-sum and explain part of the
//     surplus, which is the same finding from the other side. three
//     different P&L universes summed into one sortable column.
//   - `roi` is published without its denominator. One account shows
//     26412.04 (2,641,204 %) on $16 k of volume.
//
// None of this needs a node. The retired SGP node was the only source of
// complete per-fill data (the public CDN serves `builder_fills` and
// nothing else: node_fills, fills, node_trades, trades, asset_ctxs,
// market_data, liquidations and funding all answer 403), but per-account
// PnL does not require fills. The info API's `portfolio` request returns
// pnlHistory and accountValueHistory per address over four windows plus a
// perp-only mirror of each, which is exactly the decomposition the
// leaderboard flattens. Reading `perpAllTime` against `allTime` turns the
// zero-volume cohort from an inference into a per-account measurement.
package script

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

const (
	// LeaderboardURL is the venue's own published table. Public, keyless.
	LeaderboardURL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
	// InfoAPIURL serves the per-account `portfolio` request.
	InfoAPIURL = "https://api.hyperliquid.xyz/info"

	// leaderboardMaxBytes caps the decompressed read. The blob measured
	// 38.8 MB on 2026-10-03; 256 MB leaves room for years of growth while
	// still refusing an unbounded body.
	leaderboardMaxBytes = 256 << 20

	// roiOutlierThreshold is the |roi| above which the published ratio
	// cannot be read as a return. 100 means 10,000 %: survivable for a
	// genuine small-base account, which is the point. the figure is
	// published next to PnL with no denominator, so it is not comparable
	// across rows whatever its value.
	roiOutlierThreshold = 100.0
)

// WindowPerf is one window's figures, as published (strings).
type WindowPerf struct {
	PnL string `json:"pnl"`
	ROI string `json:"roi"`
	Vlm string `json:"vlm"`
}

// Perf is a parsed window.
type Perf struct {
	PnL float64
	ROI float64
	Vlm float64
}

// Account is one leaderboard row, parsed.
type Account struct {
	Address string
	Equity  float64
	// Windows keyed by the venue's own names: day, week, month, allTime.
	Windows map[string]Perf
	// AllTimeOK reports that the lifetime window was present and both its
	// PnL and volume parsed. Only such rows may enter the zero-volume
	// cohort; see parseFloatOK.
	AllTimeOK bool
}

// AllTime is the lifetime window, or the zero value when the row omits
// it. Callers treat a missing window as zeros rather than erroring: the
// blob is the venue's, and a shape change should degrade the audit, not
// stop the archive.
func (a Account) AllTime() Perf { return a.Windows["allTime"] }

// leaderboardEnvelope mirrors the published JSON. windowPerformances is a
// heterogeneous array of [name, figures] pairs, so it decodes through
// RawMessage rather than a struct.
type leaderboardEnvelope struct {
	LeaderboardRows []struct {
		EthAddress   string              `json:"ethAddress"`
		AccountValue string              `json:"accountValue"`
		WindowPerfs  [][]json.RawMessage `json:"windowPerformances"`
	} `json:"leaderboardRows"`
}

// parseFloat is lenient by design: the blob is all strings, and a field
// we cannot read is worth zero rather than an aborted run.
func parseFloat(s string) float64 {
	v, _ := parseFloatOK(s)
	return v
}

// parseFloatOK is the same parse, reporting whether it succeeded.
//
// The distinction matters in exactly one place and it is the headline.
// The zero-volume cohort is defined as "volume is zero while PnL is
// not", so a `vlm` that merely failed to parse would enter the count as
// a real zero and inflate the finding silently. On 2026-10-03 the live
// blob had zero non-numeric fields across all 47,123 rows, so this
// guards a format change rather than today's data. Unreadable rows are
// counted into Integrity.MalformedRows and published, so a change is
// loud instead of flattering.
func parseFloatOK(s string) (float64, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// ParseLeaderboard decodes the published blob into accounts.
func ParseLeaderboard(r io.Reader) ([]Account, error) {
	var env leaderboardEnvelope
	dec := json.NewDecoder(io.LimitReader(r, leaderboardMaxBytes))
	if err := dec.Decode(&env); err != nil {
		return nil, fmt.Errorf("decode leaderboard: %w", err)
	}
	if len(env.LeaderboardRows) == 0 {
		return nil, fmt.Errorf("leaderboard carried no rows")
	}
	out := make([]Account, 0, len(env.LeaderboardRows))
	for _, row := range env.LeaderboardRows {
		if row.EthAddress == "" {
			continue
		}
		acc := Account{
			Address: strings.ToLower(row.EthAddress),
			Equity:  parseFloat(row.AccountValue),
			Windows: make(map[string]Perf, len(row.WindowPerfs)),
		}
		for _, pair := range row.WindowPerfs {
			if len(pair) != 2 {
				continue
			}
			var name string
			if err := json.Unmarshal(pair[0], &name); err != nil {
				continue
			}
			var w WindowPerf
			if err := json.Unmarshal(pair[1], &w); err != nil {
				continue
			}
			pnl, pnlOK := parseFloatOK(w.PnL)
			vlm, vlmOK := parseFloatOK(w.Vlm)
			acc.Windows[name] = Perf{
				PnL: pnl,
				ROI: parseFloat(w.ROI),
				Vlm: vlm,
			}
			if name == "allTime" {
				acc.AllTimeOK = pnlOK && vlmOK
			}
		}
		out = append(out, acc)
	}
	return out, nil
}

// Integrity is the audit, computed from one snapshot. Every field is a
// count or a sum over the published rows: nothing here is modelled, so a
// reader can recompute all of it from the same blob.
type Integrity struct {
	Accounts int `json:"accounts"`
	// Winners counts accounts with all-time PnL > 0. Its share is the
	// zero-sum tell: a perp market cannot hand a majority a profit.
	Winners    int     `json:"winners"`
	WinnersPct float64 `json:"winners_pct"`
	AggPnL     float64 `json:"agg_pnl_usd"`
	AggEquity  float64 `json:"agg_equity_usd"`
	AggVlm     float64 `json:"agg_vlm_usd"`
	// ZeroVlm is the cohort whose row claims profit on no volume: the
	// seam between the two fields, in accounts and in dollars.
	ZeroVlmAccounts int     `json:"zero_vlm_accounts"`
	ZeroVlmPnL      float64 `json:"zero_vlm_pnl_usd"`
	ZeroVlmPnLPct   float64 `json:"zero_vlm_pnl_pct"`
	// Top100PnLPct is concentration: how much of the aggregate the first
	// hundred rows carry.
	Top100PnLPct float64 `json:"top100_pnl_pct"`
	// ROIOutliers counts rows whose published ROI cannot be read as a
	// return (see roiOutlierThreshold).
	ROIOutliers int `json:"roi_outliers"`
	// LosersPnL is the summed loss, kept separate so the aggregate's
	// sign is attributable rather than a single net figure.
	LosersPnL float64 `json:"losers_pnl_usd"`
	// MalformedRows counts rows whose lifetime window was absent or
	// unreadable. Expected to be zero; a non-zero value means the blob's
	// shape moved and every figure above needs re-reading before it is
	// quoted.
	MalformedRows int `json:"malformed_rows"`
}

// Audit computes the integrity figures over a parsed leaderboard.
func Audit(accounts []Account) Integrity {
	in := Integrity{Accounts: len(accounts)}
	if len(accounts) == 0 {
		return in
	}
	pnls := make([]float64, 0, len(accounts))
	for _, a := range accounts {
		at := a.AllTime()
		in.AggPnL += at.PnL
		in.AggEquity += a.Equity
		in.AggVlm += at.Vlm
		if at.PnL > 0 {
			in.Winners++
		} else {
			in.LosersPnL += at.PnL
		}
		if !a.AllTimeOK {
			in.MalformedRows++
		} else if at.Vlm == 0 && at.PnL != 0 {
			// Only a row we actually read may count: a vlm that failed
			// to parse is not a zero.
			in.ZeroVlmAccounts++
			in.ZeroVlmPnL += at.PnL
		}
		if math.Abs(at.ROI) > roiOutlierThreshold {
			in.ROIOutliers++
		}
		pnls = append(pnls, at.PnL)
	}
	in.WinnersPct = pct(float64(in.Winners), float64(in.Accounts))
	in.ZeroVlmPnLPct = pct(in.ZeroVlmPnL, in.AggPnL)

	sort.Sort(sort.Reverse(sort.Float64Slice(pnls)))
	n := 100
	if len(pnls) < n {
		n = len(pnls)
	}
	var top float64
	for _, v := range pnls[:n] {
		top += v
	}
	in.Top100PnLPct = pct(top, in.AggPnL)
	return in
}

// pct guards the division so an empty or zero-sum denominator yields 0
// rather than NaN, which would poison a Prometheus gauge silently.
func pct(num, den float64) float64 {
	if den == 0 {
		return 0
	}
	return 100 * num / den
}

// FetchLeaderboard GETs the published blob.
func FetchLeaderboard(ctx context.Context, client *http.Client, url string) ([]Account, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("leaderboard get: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("leaderboard http %d", resp.StatusCode)
	}
	return ParseLeaderboard(resp.Body)
}

// userAgent identifies the probe to the venue. A shared public CDN is a
// courtesy we should be identifiable on.
const userAgent = "OpenChainBench/1.0 (+https://openchainbench.com)"
