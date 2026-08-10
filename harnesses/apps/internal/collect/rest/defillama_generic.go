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

// DeFiLlamaCollector fetches daily fees and revenue from the DeFiLlama public
// API for any protocol slug and emits treasury + LP events per day.
// No API key required.
type DeFiLlamaCollector struct {
	client *http.Client
	slug   string
}

func NewDeFiLlama(slug string) *DeFiLlamaCollector {
	return &DeFiLlamaCollector{
		client: &http.Client{Timeout: 30 * time.Second},
		slug:   slug,
	}
}

func (c *DeFiLlamaCollector) Name() string { return "defillama:" + c.slug }

type llamaChartResp struct {
	TotalDataChart [][]json.RawMessage `json:"totalDataChart"`
}

type llamaChartEntry struct {
	Ts    int64
	Value float64
}

func (c *DeFiLlamaCollector) Collect(
	ctx context.Context,
	deploymentID string,
	from, to spec.Cursor,
	out chan<- spec.FeeEvent,
) (spec.Cursor, error) {
	cursor := from

	feesURL := "https://api.llama.fi/summary/fees/" + c.slug + "?dataType=dailyFees"
	revURL := "https://api.llama.fi/summary/fees/" + c.slug + "?dataType=dailyRevenue"

	fees, err := c.fetchChart(ctx, feesURL)
	if err != nil {
		return cursor, fmt.Errorf("%s fees: %w", c.slug, err)
	}

	revMap := map[int64]float64{}
	revAvailable := true
	if revs, err := c.fetchChart(ctx, revURL); err != nil {
		revAvailable = false
	} else {
		for _, e := range revs {
			revMap[e.Ts] = e.Value
		}
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)

	for _, e := range fees {
		if e.Value <= 0 {
			continue
		}
		ts := time.Unix(e.Ts, 0).UTC()
		if !ts.Before(today) {
			continue
		}
		h := uint64(e.Ts)
		if h <= from.Height {
			continue
		}

		day := ts.Format("2006-01-02")
		grossUSD := e.Value

		if !revAvailable || revMap[e.Ts] == 0 {
			// Revenue split unknown — emit gross as burn.
			micro := int64(math.Round(grossUSD * 1e6))
			out <- spec.FeeEvent{
				DeploymentID: deploymentID,
				EventKey:     fmt.Sprintf("llama:%s:burn:%s", c.slug, day),
				Ts:           ts,
				Height:       h,
				Component:    "position_fee",
				Beneficiary:  "burn",
				Token:        "USD",
				AmountRaw:    fmt.Sprintf("%d", micro),
				Decimals:     6,
				Market:       "all",
				Finality:     spec.FinalityFinal,
				Source:       c.Name(),
			}
		} else {
			revUSD := revMap[e.Ts]
			if revUSD > grossUSD {
				revUSD = grossUSD
			}
			lpUSD := grossUSD - revUSD

			if revUSD > 0 {
				micro := int64(math.Round(revUSD * 1e6))
				out <- spec.FeeEvent{
					DeploymentID: deploymentID,
					EventKey:     fmt.Sprintf("llama:%s:treasury:%s", c.slug, day),
					Ts:           ts,
					Height:       h,
					Component:    "position_fee",
					Beneficiary:  "treasury",
					Token:        "USD",
					AmountRaw:    fmt.Sprintf("%d", micro),
					Decimals:     6,
					Market:       "all",
					Finality:     spec.FinalityFinal,
					Source:       c.Name(),
				}
			}
			if lpUSD > 0 {
				micro := int64(math.Round(lpUSD * 1e6))
				out <- spec.FeeEvent{
					DeploymentID: deploymentID,
					EventKey:     fmt.Sprintf("llama:%s:lp:%s", c.slug, day),
					Ts:           ts,
					Height:       h,
					Component:    "position_fee",
					Beneficiary:  "lp",
					Token:        "USD",
					AmountRaw:    fmt.Sprintf("%d", micro),
					Decimals:     6,
					Market:       "all",
					Finality:     spec.FinalityFinal,
					Source:       c.Name(),
				}
			}
		}

		cursor = spec.Cursor{Height: h, Ts: ts, Finalized: true}
	}

	return cursor, nil
}

func (c *DeFiLlamaCollector) fetchChart(ctx context.Context, url string) ([]llamaChartEntry, error) {
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
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var raw llamaChartResp
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	var out []llamaChartEntry
	for _, row := range raw.TotalDataChart {
		if len(row) < 2 {
			continue
		}
		var ts int64
		if err := json.Unmarshal(row[0], &ts); err != nil {
			continue
		}
		var val float64
		if err := json.Unmarshal(row[1], &val); err != nil {
			continue
		}
		out = append(out, llamaChartEntry{Ts: ts, Value: val})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ts < out[j].Ts })
	return out, nil
}
