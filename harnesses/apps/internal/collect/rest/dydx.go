package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
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

type dydxFill struct {
	ID                string `json:"id"`
	CreatedAt         string `json:"createdAt"`
	CreatedAtHeight   string `json:"createdAtHeight"`
	Side              string `json:"side"`
	Liquidity         string `json:"liquidity"` // TAKER | MAKER
	Type              string `json:"type"`
	Market            string `json:"market"`
	Price             string `json:"price"`
	Size              string `json:"size"`
	Fee               string `json:"fee"`    // USDC, 6 decimals, may be negative (rebate)
	SubaccountID      string `json:"subaccountId"`
	AffiliateRevShare string `json:"affiliateRevShare"` // USDC, optional
}

func (c *DyDXCollector) Collect(
	ctx context.Context,
	deploymentID string,
	from, to spec.Cursor,
	out chan<- spec.FeeEvent,
) (spec.Cursor, error) {
	cursor := from
	pageSize := 100

	for {
		fills, nextHeight, err := c.fetchFills(ctx, cursor.Height, pageSize)
		if err != nil {
			return cursor, fmt.Errorf("dydx: fetch fills at height %d: %w", cursor.Height, err)
		}
		if len(fills) == 0 {
			break
		}

		for _, f := range fills {
			h, _ := strconv.ParseUint(f.CreatedAtHeight, 10, 64)
			// [from, to) — exclude events at or above `to`
			if h >= to.Height {
				return cursor, nil
			}

			ts, err := time.Parse(time.RFC3339Nano, f.CreatedAt)
			if err != nil {
				continue
			}

			// Emit taker or maker fee event
			component, beneficiary := classifyDyDXFill(f)
			if component == "" {
				continue
			}

			feeAmt := f.Fee
			isRebate := len(feeAmt) > 0 && feeAmt[0] == '-'

			if isRebate {
				// Maker rebate: excluded from gross_fees, beneficiary = lp
				out <- spec.FeeEvent{
					DeploymentID: deploymentID,
					EventKey:     fmt.Sprintf("dydx:%s:fee", f.ID),
					Ts:           ts,
					Height:       h,
					Component:    "maker_rebate",
					Beneficiary:  "lp",
					Token:        "USDC",
					AmountRaw:    trimNegative(feeAmt),
					Decimals:     6,
					Market:       f.Market,
					Finality:     spec.FinalityFinal,
					Source:       "dydx-indexer",
				}
			} else {
				out <- spec.FeeEvent{
					DeploymentID: deploymentID,
					EventKey:     fmt.Sprintf("dydx:%s:fee", f.ID),
					Ts:           ts,
					Height:       h,
					Component:    component,
					Beneficiary:  beneficiary,
					Token:        "USDC",
					AmountRaw:    toMicroUSDC(feeAmt),
					Decimals:     6,
					Market:       f.Market,
					Finality:     spec.FinalityFinal,
					Source:       "dydx-indexer",
				}
			}

			// Affiliate rev share (third_party leg)
			if f.AffiliateRevShare != "" && f.AffiliateRevShare != "0" {
				out <- spec.FeeEvent{
					DeploymentID: deploymentID,
					EventKey:     fmt.Sprintf("dydx:%s:affiliate", f.ID),
					Ts:           ts,
					Height:       h,
					Component:    "affiliate_fee",
					Beneficiary:  "third_party",
					Token:        "USDC",
					AmountRaw:    toMicroUSDC(f.AffiliateRevShare),
					Decimals:     6,
					Market:       f.Market,
					Finality:     spec.FinalityFinal,
					Source:       "dydx-indexer",
				}
			}

			cursor = spec.Cursor{Height: h, Ts: ts, Finalized: true}
		}

		if nextHeight == 0 || nextHeight >= to.Height {
			break
		}
	}

	return cursor, nil
}

func (c *DyDXCollector) fetchFills(ctx context.Context, fromHeight uint64, limit int) ([]dydxFill, uint64, error) {
	url := fmt.Sprintf("%s/fills?limit=%d&createdAtHeight=%d", dydxIndexer, limit, fromHeight)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var result struct {
		Fills []dydxFill `json:"fills"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, 0, err
	}

	var maxHeight uint64
	for _, f := range result.Fills {
		h, _ := strconv.ParseUint(f.CreatedAtHeight, 10, 64)
		if h > maxHeight {
			maxHeight = h
		}
	}

	return result.Fills, maxHeight, nil
}

func classifyDyDXFill(f dydxFill) (component, beneficiary string) {
	switch f.Liquidity {
	case "TAKER":
		return "taker_fee", "staker" // split handled by materializer via allocation_params
	case "MAKER":
		return "maker_fee", "lp"
	}
	return "", ""
}

func toMicroUSDC(s string) string {
	// Input is already in USDC with 6 decimal places from the indexer
	// Strip the decimal point and return as integer string
	// e.g. "1.234567" -> "1234567"
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return "0"
	}
	return strconv.FormatInt(int64(f*1e6), 10)
}

func trimNegative(s string) string {
	if len(s) > 0 && s[0] == '-' {
		return s[1:]
	}
	return s
}
