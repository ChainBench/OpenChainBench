package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

const dydxIndexer = "https://indexer.dydx.trade/v4"

// dYdX v4 effective blended taker fee rate.
// Standard tier: 5bps. VIP tiers (which dominate volume): 2-4bps.
// Empirical blended rate ≈ 3.5bps (large traders ~60% of volume at 2-3bps,
// retail ~40% at 5bps). Using 5bps overstates fees by ~30%.
const dydxTakerFeeBps = 3.5

type DyDXCollector struct {
	client *http.Client
}

func NewDyDX() *DyDXCollector {
	return &DyDXCollector{client: &http.Client{Timeout: 30 * time.Second}}
}

func (c *DyDXCollector) Name() string { return "dydx-volume-fees" }

type dydxCandle struct {
	StartedAt string `json:"startedAt"` // "2026-08-09T00:00:00.000Z"
	USDVolume string `json:"usdVolume"`
}

func (c *DyDXCollector) Collect(
	ctx context.Context,
	deploymentID string,
	from, to spec.Cursor,
	out chan<- spec.FeeEvent,
) (spec.Cursor, error) {
	cursor := from

	// Step 1: fetch all markets, keep those with any 24h volume.
	markets, err := c.fetchActiveMarkets(ctx)
	if err != nil {
		return cursor, fmt.Errorf("dydx: markets: %w", err)
	}

	// Step 2: fetch 90d of daily candles for each active market.
	// Aggregate usdVolume per calendar day (UTC midnight).
	dailyVol := map[string]float64{} // "YYYY-MM-DD" -> total USD volume

	for _, ticker := range markets {
		candles, err := c.fetchCandles(ctx, ticker, 1000)
		if err != nil {
			// Non-fatal: skip this market if it fails.
			continue
		}
		for _, candle := range candles {
			day := candle.StartedAt[:10] // "YYYY-MM-DD"
			vol, err := strconv.ParseFloat(candle.USDVolume, 64)
			if err != nil || vol <= 0 {
				continue
			}
			dailyVol[day] += vol
		}
	}

	// Step 3: sort days and emit fee events.
	days := make([]string, 0, len(dailyVol))
	for d := range dailyVol {
		days = append(days, d)
	}
	sort.Strings(days)

	today := time.Now().UTC().Format("2006-01-02")

	for _, day := range days {
		if day >= today {
			continue // skip incomplete current day
		}

		ts, err := time.Parse("2006-01-02", day)
		if err != nil {
			continue
		}
		ts = ts.UTC()
		h := uint64(ts.Unix())

		if h <= from.Height {
			continue
		}

		vol := dailyVol[day]
		if vol <= 0 {
			continue
		}

		// fees = volume × (takerFeeBps / 10000)
		feesUSD := vol * dydxTakerFeeBps / 10000.0
		amountMicro := int64(math.Round(feesUSD * 1e6))

		out <- spec.FeeEvent{
			DeploymentID: deploymentID,
			EventKey:     fmt.Sprintf("dydx:vol-fee:%s", day),
			Ts:           ts,
			Height:       h,
			Component:    "taker_fee",
			Beneficiary:  "burn",
			Token:        "USDC",
			AmountRaw:    fmt.Sprintf("%d", amountMicro),
			Decimals:     6,
			Market:       "all",
			Finality:     spec.FinalityFinal,
			Source:       "dydx-indexer-volume",
			Meta: map[string]string{
				"usd_volume":    fmt.Sprintf("%.2f", vol),
				"fee_rate_bps":  fmt.Sprintf("%.1f", dydxTakerFeeBps),
				"note":          "volume * 5bps taker fee; maker fee = 0 on dYdX v4",
			},
		}

		cursor = spec.Cursor{Height: h + 86400, Ts: ts, Finalized: true}
	}

	return cursor, nil
}

func (c *DyDXCollector) fetchActiveMarkets(ctx context.Context) ([]string, error) {
	url := fmt.Sprintf("%s/perpetualMarkets?limit=500", dydxIndexer)
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
		Markets map[string]json.RawMessage `json:"markets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	tickers := make([]string, 0, len(result.Markets))
	for ticker := range result.Markets {
		tickers = append(tickers, ticker)
	}
	return tickers, nil
}

func (c *DyDXCollector) fetchCandles(ctx context.Context, ticker string, days int) ([]dydxCandle, error) {
	url := fmt.Sprintf("%s/candles/perpetualMarkets/%s?resolution=1DAY&limit=%d", dydxIndexer, ticker, days)
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
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var result struct {
		Candles []dydxCandle `json:"candles"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return result.Candles, nil
}
