package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

// DeFiLlama public fees API — exposes Gains Network daily fees computed from
// the first-party Dune table (dune.gains.result_g_trade_stats_defi_llama).
// No API key required. Covers Arbitrum, Polygon, Base, MegaETH, ApeChain.
const gainsLlamaFees = "https://api.llama.fi/summary/fees/gains-network?dataType=dailyFees"
const gainsLlamaRevenue = "https://api.llama.fi/summary/fees/gains-network?dataType=dailyRevenue"

type GainsTradeCollector struct {
	client *http.Client
}

func NewGainsTrade() *GainsTradeCollector {
	return &GainsTradeCollector{client: &http.Client{Timeout: 30 * time.Second}}
}

func (c *GainsTradeCollector) Name() string { return "gains-trade-defillama" }

// llamaBreakdownEntry is one row from totalDataChartBreakdown.
// [timestamp, {chain: {protocol: amount_usd}}]
type llamaBreakdownEntry struct {
	Ts     int64
	Chains map[string]map[string]float64
}

func (c *GainsTradeCollector) Collect(
	ctx context.Context,
	deploymentID string,
	from, to spec.Cursor,
	out chan<- spec.FeeEvent,
) (spec.Cursor, error) {
	cursor := from

	fees, err := c.fetchBreakdown(ctx, gainsLlamaFees)
	if err != nil {
		return cursor, fmt.Errorf("gains-trade fees: %w", err)
	}
	revenues, err := c.fetchBreakdown(ctx, gainsLlamaRevenue)
	if err != nil {
		return cursor, fmt.Errorf("gains-trade revenue: %w", err)
	}

	// Build revenue lookup by timestamp.
	revByTs := map[int64]float64{}
	for _, e := range revenues {
		revByTs[e.Ts] = e.Chains["Arbitrum"]["Gains Network"]
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)
	// WS collector (gains_trade_ws.go) handles real-time data from this date onwards.
	// DeFiLlama only backfills history before the cutoff to avoid double-counting.
	wsHandoverDate := time.Date(2026, 8, 10, 0, 0, 0, 0, time.UTC)

	for _, e := range fees {
		arbFees := e.Chains["Arbitrum"]["Gains Network"]
		if arbFees <= 0 {
			continue
		}

		ts := time.Unix(e.Ts, 0).UTC()
		if !ts.Before(today) || !ts.Before(wsHandoverDate) {
			continue // skip current day and days covered by WS collector
		}
		h := uint64(e.Ts)
		if h <= from.Height {
			continue
		}

		arbRev := revByTs[e.Ts]
		if arbRev > arbFees {
			arbRev = arbFees
		}
		lpFees := arbFees - arbRev

		// Treasury/token-holders: GNS stakers + governance (DeFiLlama "revenue")
		treasuryMicro := int64(math.Round(arbRev * 1e6))
		// LPs: gToken vault + referrals + bots + borrowing (DeFiLlama "supply-side")
		lpMicro := int64(math.Round(lpFees * 1e6))

		day := ts.Format("2006-01-02")

		if treasuryMicro > 0 {
			out <- spec.FeeEvent{
				DeploymentID: deploymentID,
				EventKey:     fmt.Sprintf("gains:arb:treasury:%s", day),
				Ts:           ts,
				Height:       h,
				Component:    "position_fee",
				Beneficiary:  "treasury",
				Token:        "USD",
				AmountRaw:    fmt.Sprintf("%d", treasuryMicro),
				Decimals:     6,
				Market:       "all",
				Finality:     spec.FinalityFinal,
				Source:       c.Name(),
				Meta: map[string]string{
					"gross_usd":  fmt.Sprintf("%.2f", arbFees),
					"source_url": gainsLlamaFees,
				},
			}
		}
		if lpMicro > 0 {
			out <- spec.FeeEvent{
				DeploymentID: deploymentID,
				EventKey:     fmt.Sprintf("gains:arb:lp:%s", day),
				Ts:           ts,
				Height:       h,
				Component:    "position_fee",
				Beneficiary:  "lp",
				Token:        "USD",
				AmountRaw:    fmt.Sprintf("%d", lpMicro),
				Decimals:     6,
				Market:       "all",
				Finality:     spec.FinalityFinal,
				Source:       c.Name(),
			}
		}

		cursor = spec.Cursor{Height: h, Ts: ts, Finalized: true}
	}

	return cursor, nil
}

// llamaResp is the shape of the DeFiLlama summary/fees endpoint.
type llamaResp struct {
	TotalDataChartBreakdown [][]json.RawMessage `json:"totalDataChartBreakdown"`
}

func (c *GainsTradeCollector) fetchBreakdown(ctx context.Context, url string) ([]llamaBreakdownEntry, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ocb-apps/1.0")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from DeFiLlama", resp.StatusCode)
	}

	var raw llamaResp
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	var out []llamaBreakdownEntry
	for _, row := range raw.TotalDataChartBreakdown {
		if len(row) < 2 {
			continue
		}
		var ts int64
		if err := json.Unmarshal(row[0], &ts); err != nil {
			continue
		}
		var chains map[string]map[string]float64
		if err := json.Unmarshal(row[1], &chains); err != nil {
			continue
		}
		out = append(out, llamaBreakdownEntry{Ts: ts, Chains: chains})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Ts < out[j].Ts })
	return out, nil
}
