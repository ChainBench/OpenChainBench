package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

// fillsAggURL is the hl-fills-agg service running on the SGP node alongside
// the Hyperliquid non-validating node. It reads hourly node_fills_by_block
// files and returns daily fee totals (gross, builder, net) in USDC.
const fillsAggURL = "http://15.235.224.14:2116"

// fillsEpoch is the earliest date available in the node fills archive.
const fillsEpoch = "20260601"

type HyperliquidCollector struct {
	client *http.Client
}

func NewHyperliquid() *HyperliquidCollector {
	return &HyperliquidCollector{client: &http.Client{Timeout: 60 * time.Second}}
}

func (c *HyperliquidCollector) Name() string { return "hyperliquid-node-fills" }

type hlDailySummary struct {
	Date       string  `json:"date"`       // "YYYYMMDD"
	GrossUSDC  float64 `json:"gross_usdc"` // all fees paid (taker + maker)
	BuilderUSDC float64 `json:"builder_usdc"` // third-party builder codes cut
	NetUSDC    float64 `json:"net_usdc"`   // gross - builder → goes to AF + HLP + deployers
	Fills      int64   `json:"fills"`
	Hours      int     `json:"hours"`
}

func (c *HyperliquidCollector) Collect(
	ctx context.Context,
	deploymentID string,
	from, to spec.Cursor,
	out chan<- spec.FeeEvent,
) (spec.Cursor, error) {
	cursor := from

	// Determine the start date string.
	// cursor.Height encodes the unix timestamp (seconds) of the last processed
	// day's midnight UTC. Zero means start from the fills epoch.
	var startDate string
	if from.Height == 0 {
		startDate = fillsEpoch
	} else {
		startDate = time.Unix(int64(from.Height), 0).UTC().Format("20060102")
	}
	endDate := to.Ts.UTC().Format("20060102")

	days, err := c.fetchDailySummaries(ctx, startDate, endDate)
	if err != nil {
		return cursor, fmt.Errorf("hyperliquid: fills-agg: %w", err)
	}

	for _, d := range days {
		ts, err := time.Parse("20060102", d.Date)
		if err != nil {
			continue
		}
		ts = ts.UTC()

		h := uint64(ts.Unix())
		if h < from.Height {
			continue
		}

		// Skip partial days (< 23 hours) — they're incomplete.
		// Today's day will be partial and should not be persisted.
		if d.Hours < 23 {
			continue
		}

		if d.NetUSDC <= 0 {
			continue
		}

		// net_usdc = all fills fees minus builder codes.
		// This is the total amount that flows to AF + HLP + deployers.
		// We classify as taker_fee/burn since the vast majority (~97-99%)
		// goes to the Assistance Fund (which burns HYPE), per the HL docs.
		// The HLP vault share and deployer share are not separable per-fill
		// and are small relative to the total.
		amountMicro := int64(math.Round(d.NetUSDC * 1e6))
		out <- spec.FeeEvent{
			DeploymentID: deploymentID,
			EventKey:     fmt.Sprintf("hl:node-fills:%s:net", d.Date),
			Ts:           ts,
			Height:       h,
			Component:    "taker_fee",
			Beneficiary:  "burn",
			Token:        "USDC",
			AmountRaw:    fmt.Sprintf("%d", amountMicro),
			Decimals:     6,
			Market:       "all",
			Finality:     spec.FinalityFinal,
			Source:       "hyperliquid-node-fills",
			Meta: map[string]string{
				"gross_usdc":   fmt.Sprintf("%.2f", d.GrossUSDC),
				"builder_usdc": fmt.Sprintf("%.2f", d.BuilderUSDC),
				"fills":        fmt.Sprintf("%d", d.Fills),
				"hours":        fmt.Sprintf("%d", d.Hours),
			},
		}

		cursor = spec.Cursor{Height: h + 86400, Ts: ts, Finalized: true}
	}

	return cursor, nil
}

func (c *HyperliquidCollector) fetchDailySummaries(ctx context.Context, from, to string) ([]hlDailySummary, error) {
	url := fmt.Sprintf("%s/daily?from=%s&to=%s", fillsAggURL, from, to)
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
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}

	var result []hlDailySummary
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return result, nil
}
