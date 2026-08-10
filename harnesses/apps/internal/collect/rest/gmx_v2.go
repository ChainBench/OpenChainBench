package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

// GMX v2 Subsquid GraphQL endpoints (first-party, GMX-operated).
// Amounts use GMX's internal PRICE_PRECISION (1e30) — store raw with Decimals=30.
const (
	gmxArbitrumSQ = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql"
	gmxAvaxSQ     = "https://gmx.squids.live/gmx-synthetics-avalanche:prod/api/graphql"
)

// Protocol revenue split per GMX governance (as of 2026):
//
//	63% → GM / GLV LPs   (beneficiary = "lp")
//	27% → GMX buyback    (beneficiary = "burn")
//	10% → Treasury       (beneficiary = "treasury")
//
// Note: staking distributions suspended as of Mar 2026; buyback tokens
// accumulate in treasury. We still book accrual at 37% protocol revenue.
const (
	gmxLPBps       = 6300 // 63%
	gmxBuybackBps  = 2700 // 27%
	gmxTreasuryBps = 1000 // 10%
)

type GMXv2Collector struct {
	client   *http.Client
	endpoint string
	chainID  string
}

func NewGMXv2Arbitrum() *GMXv2Collector {
	return &GMXv2Collector{
		client:   &http.Client{Timeout: 30 * time.Second},
		endpoint: gmxArbitrumSQ,
		chainID:  "arbitrum",
	}
}

func NewGMXv2Avalanche() *GMXv2Collector {
	return &GMXv2Collector{
		client:   &http.Client{Timeout: 30 * time.Second},
		endpoint: gmxAvaxSQ,
		chainID:  "avalanche",
	}
}

func (c *GMXv2Collector) Name() string {
	return fmt.Sprintf("gmx-v2-%s-subsquid", c.chainID)
}

type gmxDayFees struct {
	Ts          int64
	PosGross    string // totalPositionFeeUsd (BigInt, 1e30)
	PosForPool  string // totalPositionFeeUsdForPool (BigInt, 1e30)
	SwapRecv    string // totalFeeReceiverUsd from swapFees (BigInt, 1e30)
	SwapForPool string // totalFeeUsdForPool from swapFees (BigInt, 1e30)
	BorrowPool  string // totalBorrowingFeeUsd → all to pool (BigInt, 1e30)
}

func (c *GMXv2Collector) Collect(
	ctx context.Context,
	deploymentID string,
	from, to spec.Cursor,
	out chan<- spec.FeeEvent,
) (spec.Cursor, error) {
	cursor := from

	// Fetch last 90 days of daily data from Subsquid.
	// cursor.Height is the unix timestamp (seconds) of the last processed day.
	tsFrom := int(from.Height)
	if tsFrom == 0 {
		// Default: start 90 days ago.
		tsFrom = int(time.Now().AddDate(0, 0, -90).Truncate(24 * time.Hour).Unix())
	}
	tsTo := int(to.Ts.Truncate(24 * time.Hour).Unix())

	days, err := c.fetchDays(ctx, tsFrom, tsTo)
	if err != nil {
		return cursor, fmt.Errorf("gmx-v2: %w", err)
	}

	for _, d := range days {
		if uint64(d.Ts) <= from.Height {
			continue
		}
		ts := time.Unix(d.Ts, 0).UTC()

		// Skip current incomplete day.
		if ts.Truncate(24 * time.Hour).Equal(time.Now().UTC().Truncate(24 * time.Hour)) {
			continue
		}

		emitBigInt := func(component, beneficiary, amountRaw string) {
			if amountRaw == "" || amountRaw == "0" {
				return
			}
			out <- spec.FeeEvent{
				DeploymentID: deploymentID,
				EventKey:     fmt.Sprintf("gmx-v2:%s:%d:%s:%s", c.chainID, d.Ts, component, beneficiary),
				Ts:           ts,
				Height:       uint64(d.Ts),
				Component:    component,
				Beneficiary:  beneficiary,
				Token:        "USD",
				AmountRaw:    amountRaw,
				Decimals:     30,
				Market:       "all",
				Finality:     spec.FinalityFinal,
				Source:       c.Name(),
			}
		}

		// Position fees: gross = PosGross, split between LP (posForPool) and protocol (posGross - posForPool).
		// Compute posForProtocol = posGross - posForPool in string form for BigInt safety.
		posProtocol := bigSubStr(d.PosGross, d.PosForPool)
		emitBigInt("position_fee", "lp", d.PosForPool)
		emitBigInt("position_fee", "burn", posProtocol)

		// Swap fees: receiver is protocol's cut, pool is LP's cut.
		emitBigInt("swap_fee", "burn", d.SwapRecv)
		emitBigInt("swap_fee", "lp", d.SwapForPool)

		// Borrowing fees go entirely to the pool (LPs), not to protocol.
		emitBigInt("borrow_fee", "lp", d.BorrowPool)

		cursor = spec.Cursor{Height: uint64(d.Ts), Ts: ts, Finalized: true}
	}

	return cursor, nil
}

// fetchDays queries both positionFees and swapFees daily data and merges by timestamp.
func (c *GMXv2Collector) fetchDays(ctx context.Context, tsFrom, tsTo int) ([]gmxDayFees, error) {
	// Fetch position fees.
	posQuery := fmt.Sprintf(`{
		positionFeesInfoWithPeriods(orderBy:timestamp_ASC, where:{period_eq:"1d",timestamp_gte:%d,timestamp_lt:%d}, limit:500) {
			timestamp totalPositionFeeUsd totalPositionFeeUsdForPool totalBorrowingFeeUsd
		}
	}`, tsFrom, tsTo)

	type posEntry struct {
		Timestamp              int    `json:"timestamp"`
		TotalPositionFeeUsd    string `json:"totalPositionFeeUsd"`
		TotalPositionFeeUsdForPool string `json:"totalPositionFeeUsdForPool"`
		TotalBorrowingFeeUsd   string `json:"totalBorrowingFeeUsd"`
	}
	var posResp struct {
		Data struct {
			Items []posEntry `json:"positionFeesInfoWithPeriods"`
		} `json:"data"`
		Errors []struct{ Message string } `json:"errors"`
	}
	if err := c.gqlQuery(ctx, posQuery, &posResp); err != nil {
		return nil, fmt.Errorf("position fees: %w", err)
	}
	if len(posResp.Errors) > 0 {
		return nil, fmt.Errorf("position fees gql: %s", posResp.Errors[0].Message)
	}

	// Fetch swap fees.
	swapQuery := fmt.Sprintf(`{
		swapFeesInfoWithPeriods(orderBy:timestamp_ASC, where:{period_eq:"1d",timestamp_gte:%d,timestamp_lt:%d}, limit:500) {
			timestamp totalFeeReceiverUsd totalFeeUsdForPool
		}
	}`, tsFrom, tsTo)

	type swapEntry struct {
		Timestamp          int    `json:"timestamp"`
		TotalFeeReceiverUsd string `json:"totalFeeReceiverUsd"`
		TotalFeeUsdForPool  string `json:"totalFeeUsdForPool"`
	}
	var swapResp struct {
		Data struct {
			Items []swapEntry `json:"swapFeesInfoWithPeriods"`
		} `json:"data"`
		Errors []struct{ Message string } `json:"errors"`
	}
	if err := c.gqlQuery(ctx, swapQuery, &swapResp); err != nil {
		return nil, fmt.Errorf("swap fees: %w", err)
	}
	if len(swapResp.Errors) > 0 {
		return nil, fmt.Errorf("swap fees gql: %s", swapResp.Errors[0].Message)
	}

	// Merge by timestamp.
	posByTs := map[int]posEntry{}
	for _, p := range posResp.Data.Items {
		posByTs[p.Timestamp] = p
	}
	swapByTs := map[int]swapEntry{}
	for _, s := range swapResp.Data.Items {
		swapByTs[s.Timestamp] = s
	}

	// Collect all unique timestamps.
	seen := map[int]bool{}
	for ts := range posByTs {
		seen[ts] = true
	}
	for ts := range swapByTs {
		seen[ts] = true
	}

	var out []gmxDayFees
	for ts := range seen {
		p := posByTs[ts]
		s := swapByTs[ts]
		out = append(out, gmxDayFees{
			Ts:          int64(ts),
			PosGross:    orZero(p.TotalPositionFeeUsd),
			PosForPool:  orZero(p.TotalPositionFeeUsdForPool),
			SwapRecv:    orZero(s.TotalFeeReceiverUsd),
			SwapForPool: orZero(s.TotalFeeUsdForPool),
			BorrowPool:  orZero(p.TotalBorrowingFeeUsd),
		})
	}

	// Sort by timestamp ascending.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Ts < out[j-1].Ts; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

func (c *GMXv2Collector) gqlQuery(ctx context.Context, query string, dest interface{}) error {
	body, _ := json.Marshal(map[string]string{"query": query})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ocb-apps/1.0")

	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(dest)
}

// bigSubStr subtracts two base-10 integer strings: a - b.
// Uses strconv for small values; falls back to manual subtraction for large BigInt strings.
func bigSubStr(a, b string) string {
	// Simple approach: parse both, subtract.
	// For 30-decimal GMX values, a and b are ~35 digits — use Go's math/big indirectly
	// by doing string arithmetic. Since b <= a always (pool ≤ gross), result is non-negative.
	if a == "" || a == "0" {
		return "0"
	}
	if b == "" || b == "0" {
		return a
	}
	// Pad to same length.
	for len(a) < len(b) {
		a = "0" + a
	}
	for len(b) < len(a) {
		b = "0" + b
	}
	result := make([]byte, len(a))
	borrow := 0
	for i := len(a) - 1; i >= 0; i-- {
		diff := int(a[i]-'0') - int(b[i]-'0') - borrow
		if diff < 0 {
			diff += 10
			borrow = 1
		} else {
			borrow = 0
		}
		result[i] = byte('0' + diff)
	}
	// Trim leading zeros.
	s := string(result)
	for len(s) > 1 && s[0] == '0' {
		s = s[1:]
	}
	return s
}

func orZero(s string) string {
	if s == "" {
		return "0"
	}
	return s
}
