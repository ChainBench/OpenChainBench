package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

// The Graph Network endpoint for Gains.trade v8 Arbitrum subgraph.
// Subgraph ID confirmed live (returns 401 without key, not 404).
// Get a free API key at https://thegraph.com/studio/ → API Keys.
const gainsSubgraphEndpoint = "https://gateway.thegraph.com/api/%s/subgraphs/id/EHbGEiQemsPzaKBkuZ2vOPiQAGEKdMHhnaLxBvXUL8n6"

// Gains.trade fee split (Arbitrum v8, 2026):
//   33% → gToken vault (gUSDC LPs)      → beneficiary "lp"
//   40% → GNS stakers (SSS)             → beneficiary "treasury"
//   27% → governance + referrals + triggers → beneficiary "treasury"
// LPs and protocol split: 33 / 67 (rounded).
const (
	gainsLPBps       = 3300
	gainsProtocolBps = 6700
)

type GainsTradeCollector struct {
	client *http.Client
	apiKey string
}

func NewGainsTrade(apiKey string) *GainsTradeCollector {
	return &GainsTradeCollector{
		client: &http.Client{Timeout: 30 * time.Second},
		apiKey: apiKey,
	}
}

func (c *GainsTradeCollector) Name() string { return "gains-trade-arb-subgraph" }

func (c *GainsTradeCollector) Collect(
	ctx context.Context,
	deploymentID string,
	from, to spec.Cursor,
	out chan<- spec.FeeEvent,
) (spec.Cursor, error) {
	cursor := from

	tsFrom := int64(from.Height)
	if tsFrom == 0 {
		tsFrom = time.Now().AddDate(0, 0, -90).Truncate(24 * time.Hour).Unix()
	}
	tsTo := to.Ts.Truncate(24 * time.Hour).Unix()

	days, err := c.fetchDays(ctx, tsFrom, tsTo)
	if err != nil {
		return cursor, fmt.Errorf("gains-trade: %w", err)
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)

	for _, day := range days {
		if !day.ts.Before(today) {
			continue
		}
		h := uint64(day.ts.Unix())
		if h <= from.Height {
			continue
		}
		if day.feesUSD <= 0 {
			continue
		}

		lpUSD := day.feesUSD * float64(gainsLPBps) / 10000.0
		protUSD := day.feesUSD * float64(gainsProtocolBps) / 10000.0

		out <- spec.FeeEvent{
			DeploymentID: deploymentID,
			EventKey:     fmt.Sprintf("gains:arb:lp:%s", day.date),
			Ts:           day.ts,
			Height:       h,
			Component:    "position_fee",
			Beneficiary:  "lp",
			Token:        "USD",
			AmountRaw:    fmt.Sprintf("%d", int64(math.Round(lpUSD*1e6))),
			Decimals:     6,
			Market:       "all",
			Finality:     spec.FinalityFinal,
			Source:       c.Name(),
		}
		out <- spec.FeeEvent{
			DeploymentID: deploymentID,
			EventKey:     fmt.Sprintf("gains:arb:treasury:%s", day.date),
			Ts:           day.ts,
			Height:       h,
			Component:    "position_fee",
			Beneficiary:  "treasury",
			Token:        "USD",
			AmountRaw:    fmt.Sprintf("%d", int64(math.Round(protUSD*1e6))),
			Decimals:     6,
			Market:       "all",
			Finality:     spec.FinalityFinal,
			Source:       c.Name(),
		}

		cursor = spec.Cursor{Height: h, Ts: day.ts, Finalized: true}
	}

	return cursor, nil
}

type gainsDayResult struct {
	ts      time.Time
	date    string
	feesUSD float64
}

func (c *GainsTradeCollector) fetchDays(ctx context.Context, tsFrom, tsTo int64) ([]gainsDayResult, error) {
	// The Gains.trade v8 subgraph uses dayDatas with unix timestamp `date` field.
	query := fmt.Sprintf(`{
		dayDatas(first: 100, orderBy: date, orderDirection: asc,
				 where: {date_gte: %d, date_lt: %d}) {
			date
			feesUsd
		}
	}`, tsFrom, tsTo)

	body, _ := json.Marshal(map[string]string{"query": query})
	url := fmt.Sprintf(gainsSubgraphEndpoint, c.apiKey)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from The Graph", resp.StatusCode)
	}

	var result struct {
		Data struct {
			DayDatas []struct {
				Date    json.Number `json:"date"`
				FeesUsd string      `json:"feesUsd"`
			} `json:"dayDatas"`
		} `json:"data"`
		Errors []struct{ Message string } `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if len(result.Errors) > 0 {
		return nil, fmt.Errorf("graphql: %s", result.Errors[0].Message)
	}

	var out []gainsDayResult
	for _, d := range result.Data.DayDatas {
		unixTs, err := d.Date.Int64()
		if err != nil {
			continue
		}
		ts := time.Unix(unixTs, 0).UTC()
		feesUSD, err := strconv.ParseFloat(d.FeesUsd, 64)
		if err != nil {
			continue
		}
		out = append(out, gainsDayResult{
			ts:      ts,
			date:    ts.Format("2006-01-02"),
			feesUSD: feesUSD,
		})
	}
	return out, nil
}
