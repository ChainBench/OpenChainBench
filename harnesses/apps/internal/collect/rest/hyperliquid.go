package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

const defilllamaHL = "https://api.llama.fi/summary/fees/hyperliquid"

type HyperliquidCollector struct {
	client *http.Client
}

func NewHyperliquid() *HyperliquidCollector {
	return &HyperliquidCollector{client: &http.Client{Timeout: 30 * time.Second}}
}

func (c *HyperliquidCollector) Name() string { return "hyperliquid-defillama" }

// hlDayBreakdown holds the per-category fees for one day as returned by DeFiLlama.
// Perps → taker_fee / burn (goes to AF which buys+burns HYPE)
// HLP   → taker_fee / lp  (HLP vault earns from market making)
// Spot  → spot_fee  / burn (spot orderbook fees, mostly AF)
type hlDayBreakdown struct {
	Ts    int64   // unix seconds (DeFiLlama bucket start)
	Perps float64 // "Hyperliquid Perps"
	HLP   float64 // "Hyperliquid HLP"
	Spot  float64 // "Hyperliquid Spot Orderbook"
}

func (c *HyperliquidCollector) Collect(
	ctx context.Context,
	deploymentID string,
	from, to spec.Cursor,
	out chan<- spec.FeeEvent,
) (spec.Cursor, error) {
	cursor := from

	days, err := c.fetchBreakdown(ctx)
	if err != nil {
		return cursor, fmt.Errorf("hyperliquid: defillama: %w", err)
	}

	for _, d := range days {
		// Use unix timestamp (seconds) as synthetic height for cursor tracking.
		h := uint64(d.Ts)
		if h < from.Height {
			continue
		}
		if h >= to.Height {
			break
		}

		ts := time.Unix(d.Ts, 0).UTC()

		// Skip days with zero fees (typically the incomplete current day at the tail).
		if d.Perps == 0 && d.HLP == 0 && d.Spot == 0 {
			continue
		}

		// DeFiLlama returns whole-dollar amounts.
		// Store as raw USD integer strings with Decimals=0.
		emit := func(component, beneficiary string, amount float64) {
			if amount <= 0 {
				return
			}
			out <- spec.FeeEvent{
				DeploymentID: deploymentID,
				EventKey:     fmt.Sprintf("hl:defillama:%d:%s:%s", d.Ts, component, beneficiary),
				Ts:           ts,
				Height:       h,
				Component:    component,
				Beneficiary:  beneficiary,
				Token:        "USD",
				AmountRaw:    fmt.Sprintf("%d", int64(amount)),
				Decimals:     0,
				Market:       "all",
				Finality:     spec.FinalityFinal,
				Source:       "defillama-hyperliquid",
				Meta: map[string]string{
					"note": "Phase 1 proxy via DeFiLlama. Will be replaced by S3 fills in Phase 2.",
				},
			}
		}

		emit("taker_fee", "burn", d.Perps)
		emit("taker_fee", "lp", d.HLP)
		emit("spot_fee", "burn", d.Spot)

		cursor = spec.Cursor{Height: h + 86400, Ts: ts, Finalized: true}
	}

	return cursor, nil
}

func (c *HyperliquidCollector) fetchBreakdown(ctx context.Context) ([]hlDayBreakdown, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, defilllamaHL, nil)
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
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, defilllamaHL)
	}

	var result struct {
		TotalDataChartBreakdown [][]json.RawMessage `json:"totalDataChartBreakdown"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	out := make([]hlDayBreakdown, 0, len(result.TotalDataChartBreakdown))
	for _, entry := range result.TotalDataChartBreakdown {
		if len(entry) < 2 {
			continue
		}
		var ts int64
		if err := json.Unmarshal(entry[0], &ts); err != nil {
			continue
		}

		// breakdown shape: {"Hyperliquid L1": {"Hyperliquid Perps": N, "Hyperliquid HLP": N, ...}}
		var outer map[string]map[string]float64
		if err := json.Unmarshal(entry[1], &outer); err != nil {
			continue
		}
		inner, ok := outer["Hyperliquid L1"]
		if !ok {
			continue
		}

		out = append(out, hlDayBreakdown{
			Ts:    ts,
			Perps: inner["Hyperliquid Perps"],
			HLP:   inner["Hyperliquid HLP"],
			Spot:  inner["Hyperliquid Spot Orderbook"],
		})
	}

	return out, nil
}
