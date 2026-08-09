package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

const dydxIndexer = "https://indexer.dydx.trade/v4"

type DyDXCollector struct {
	client *http.Client
}

func NewDyDX() *DyDXCollector {
	return &DyDXCollector{client: &http.Client{Timeout: 30 * time.Second}}
}

func (c *DyDXCollector) Name() string { return "dydx-rest" }

// megavaultPnlEntry is one day of MegaVault historical PnL.
// MegaVault receives ~50% of all taker fees — tracking its PnL gives us lp_revenue directly.
// Source: GET /v4/vault/v1/megavault/historicalPnl
type megavaultPnlEntry struct {
	Equity           string `json:"equity"`
	TotalPnl         string `json:"totalPnl"`
	NetTransfers     string `json:"netTransfers"`
	CreatedAt        string `json:"createdAt"`       // "2026-01-15T00:00:00.000Z"
	BlockHeight      string `json:"blockHeight"`
	BlockTime        string `json:"blockTime"`
}

func (c *DyDXCollector) Collect(
	ctx context.Context,
	deploymentID string,
	from, to spec.Cursor,
	out chan<- spec.FeeEvent,
) (spec.Cursor, error) {
	cursor := from

	entries, err := c.fetchMegavaultPnl(ctx)
	if err != nil {
		return cursor, fmt.Errorf("dydx: megavault pnl: %w", err)
	}

	// totalPnl is cumulative; emit daily deltas only.
	// entries arrive oldest-first from the indexer.
	for i, e := range entries {
		h, _ := strconv.ParseUint(e.BlockHeight, 10, 64)
		if h < from.Height {
			continue
		}
		if h >= to.Height {
			break
		}

		ts, err := parseTime(e.BlockTime)
		if err != nil {
			ts, err = parseTime(e.CreatedAt)
			if err != nil {
				continue
			}
		}

		// Daily delta = this snapshot's cumulative PnL minus previous snapshot's.
		// Skip first entry (no previous to diff against) or loss days.
		if i == 0 {
			continue
		}
		delta := pnlDelta(entries[i-1].TotalPnl, e.TotalPnl)
		if delta == "" || strings.HasPrefix(delta, "-") || delta == "0" {
			continue
		}

		out <- spec.FeeEvent{
			DeploymentID: deploymentID,
			EventKey:     fmt.Sprintf("dydx:megavault:%s", e.BlockHeight),
			Ts:           ts,
			Height:       h,
			Component:    "taker_fee",
			Beneficiary:  "lp",
			Token:        "USDC",
			AmountRaw:    delta,
			Decimals:     0,
			Market:       "all",
			Finality:     spec.FinalityFinal,
			Source:       "dydx-indexer-megavault-pnl",
			Meta: map[string]string{
				"note":          "MegaVault daily PnL delta ~ 50% of taker fees. Full split applied by materializer.",
				"equity":        e.Equity,
				"net_transfers": e.NetTransfers,
				"total_pnl":     e.TotalPnl,
			},
		}

		cursor = spec.Cursor{Height: h + 1, Ts: ts, Finalized: true}
	}

	return cursor, nil
}

func (c *DyDXCollector) fetchMegavaultPnl(ctx context.Context) ([]megavaultPnlEntry, error) {
	url := fmt.Sprintf("%s/vault/v1/megavault/historicalPnl", dydxIndexer)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}

	var result struct {
		MegavaultPnl []megavaultPnlEntry `json:"megavaultPnl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	return result.MegavaultPnl, nil
}

// pnlDelta subtracts two integer-string USDC values and returns the delta as a string.
// Returns "" if either input is malformed.
func pnlDelta(prev, curr string) string {
	p, err1 := strconv.ParseInt(prev, 10, 64)
	c, err2 := strconv.ParseInt(curr, 10, 64)
	if err1 != nil || err2 != nil {
		return ""
	}
	d := c - p
	return strconv.FormatInt(d, 10)
}

func parseTime(s string) (time.Time, error) {
	formats := []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.000Z",
		"2006-01-02T15:04:05Z",
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot parse time: %q", s)
}
