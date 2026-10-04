// traders_run.go — one audit cycle, and the snapshot the site reads.
package script

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"time"
)

// tradersUpstashRowCap bounds the account rows pushed to Upstash.
//
// The whole blob is ~39 MB for ~47k accounts and the Upstash free-tier
// ceiling is 1 MB per key, which the builder payload already sizes
// against (upstashTimeseriesDaysCap). 500 rows at roughly 120 B of JSON
// each lands near 60 KB, leaving the audit figures and future fields
// plenty of room. The full set stays on the harness; the page ranks the
// top, and the audit figures are aggregates over all 47k regardless of
// this cap.
const tradersUpstashRowCap = 500

// TraderRow is one published account, as the page ranks it.
type TraderRow struct {
	Address string  `json:"address"`
	Equity  float64 `json:"equity_usd"`
	PnL     float64 `json:"pnl_usd"`
	ROI     float64 `json:"roi"`
	Vlm     float64 `json:"vlm_usd"`
	PnLDay  float64 `json:"pnl_day_usd"`
	// NoVolume flags a row claiming PnL on zero volume, so the page can
	// mark it in place instead of dropping it and publishing the
	// flattering half of the table.
	NoVolume bool `json:"no_volume"`
}

// TradersSnapshot is the payload the Next.js page consumes.
type TradersSnapshot struct {
	UpdatedAt     string        `json:"updated_at"`
	Source        string        `json:"source"`
	Integrity     Integrity     `json:"integrity"`
	Decomposition Decomposition `json:"decomposition"`
	// Top is capped (tradersUpstashRowCap) and ordered by all-time PnL.
	Top []TraderRow `json:"top"`
	// RowCap is published so the page can say "top 500 of 47,107"
	// instead of implying the table is complete.
	RowCap int `json:"row_cap"`
}

// TradersOptions configures one cycle. Zero values take the documented
// defaults so `traders` runs with no env set.
type TradersOptions struct {
	// SampleSize is how many of the highest-PnL accounts get an info API
	// portfolio read for the perp/non-perp split. 0 disables sampling.
	//
	// Sampling the top is deliberate: those are the rows the leaderboard
	// showcases, and auditing them is the point. It is also biased by
	// construction, because the highest-PnL rows are disproportionately
	// the zero-volume cohort. On 2026-10-03 the top 8 came back 81.7 %
	// non-perp against 18 % on a single mid-table account. Whatever
	// consumes hl_traders_non_perp_pnl_pct has to say "of the top N",
	// which is why Decomposition.Sampled travels with it.
	SampleSize int
	// RequestsPerSecond paces the info API sweep.
	RequestsPerSecond float64
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v >= 0 {
		return v
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(key), 64); err == nil && v > 0 {
		return v
	}
	return def
}

// TradersOptionsFromEnv reads the two knobs.
func TradersOptionsFromEnv() TradersOptions {
	return TradersOptions{
		SampleSize:        envInt("HL_TRADERS_SAMPLE_SIZE", 500),
		RequestsPerSecond: envFloat("HL_TRADERS_RPS", 5),
	}
}

// RunTraders fetches the published leaderboard, audits it, samples the
// per-account decomposition, and publishes both.
//
// Ordering matters: gauges are set from the audit before the info API
// sweep starts, so a rate-limited or interrupted sweep still leaves the
// leaderboard figures published rather than nothing.
func RunTraders(ctx context.Context, opts TradersOptions) (*TradersSnapshot, error) {
	client := &http.Client{Timeout: 3 * time.Minute}

	accounts, err := FetchLeaderboard(ctx, client, LeaderboardURL)
	if err != nil {
		return nil, err
	}
	Log.Info("leaderboard read", "accounts", len(accounts))

	audit := Audit(accounts)
	publishAuditGauges(audit)

	rows := rankRows(accounts)

	var dec Decomposition
	if opts.SampleSize > 0 {
		n := opts.SampleSize
		if n > len(rows) {
			n = len(rows)
		}
		addrs := make([]string, 0, n)
		for _, r := range rows[:n] {
			addrs = append(addrs, r.Address)
		}
		// A deadline sized to the pace: the sweep needs n/rps seconds, so
		// four times that plus a minute absorbs retries and slow
		// responses while guaranteeing the cycle ends well before the
		// next daily run can overlap it.
		budget := time.Duration(float64(n)/opts.RequestsPerSecond*4)*time.Second + time.Minute
		sweepCtx, cancel := context.WithTimeout(ctx, budget)
		defer cancel()
		sampleClient := &http.Client{Timeout: 30 * time.Second}
		dec, _ = SamplePortfolios(sweepCtx, sampleClient, addrs, opts.RequestsPerSecond)
		MetricTradersSampled.Set(float64(dec.Sampled))
		MetricTradersNonPerpPnLPct.Set(dec.NonPerpPct)
		Log.Info("portfolio sweep done",
			"sampled", dec.Sampled, "failed", dec.Failed,
			"non_perp_pct", fmt.Sprintf("%.1f", dec.NonPerpPct))
	}

	if len(rows) > tradersUpstashRowCap {
		rows = rows[:tradersUpstashRowCap]
	}
	snap := &TradersSnapshot{
		UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
		Source:        LeaderboardURL,
		Integrity:     audit,
		Decomposition: dec,
		Top:           rows,
		RowCap:        tradersUpstashRowCap,
	}
	MetricTradersLastRun.Set(float64(time.Now().Unix()))
	return snap, nil
}

// rankRows orders every account by all-time PnL, descending.
func rankRows(accounts []Account) []TraderRow {
	rows := make([]TraderRow, 0, len(accounts))
	for _, a := range accounts {
		at := a.AllTime()
		rows = append(rows, TraderRow{
			Address:  a.Address,
			Equity:   a.Equity,
			PnL:      at.PnL,
			ROI:      at.ROI,
			Vlm:      at.Vlm,
			PnLDay:   a.Windows["day"].PnL,
			NoVolume: at.Vlm == 0 && at.PnL != 0,
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].PnL > rows[j].PnL })
	return rows
}

func publishAuditGauges(in Integrity) {
	MetricTradersAccounts.Set(float64(in.Accounts))
	MetricTradersWinnersPct.Set(in.WinnersPct)
	MetricTradersAggPnL.Set(in.AggPnL)
	MetricTradersAggEquity.Set(in.AggEquity)
	MetricTradersAggVlm.Set(in.AggVlm)
	MetricTradersZeroVlmAccounts.Set(float64(in.ZeroVlmAccounts))
	MetricTradersZeroVlmPnL.Set(in.ZeroVlmPnL)
	MetricTradersZeroVlmPnLPct.Set(in.ZeroVlmPnLPct)
	MetricTradersTop100PnLPct.Set(in.Top100PnLPct)
	MetricTradersROIOutliers.Set(float64(in.ROIOutliers))
	MetricTradersMalformedRows.Set(float64(in.MalformedRows))
}

// PushTradersUpstash writes the snapshot under its own key, leaving the
// builder payload untouched. No-op when Upstash is unconfigured so local
// runs work.
func PushTradersUpstash(ctx context.Context, snap *TradersSnapshot) error {
	key := os.Getenv("HL_TRADERS_UPSTASH_KEY")
	if key == "" {
		key = "ocb:hl-traders:v1"
	}
	body, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("marshal traders snapshot: %w", err)
	}
	return upstashSet(ctx, key, body)
}
