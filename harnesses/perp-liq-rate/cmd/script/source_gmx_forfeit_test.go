package main

// source_gmx_forfeit_test.go: the GMX forfeited-collateral decode pinned against
// a real squid row, with the payout it predicts checked against the chain.
//
// The row is order 0xae235265 in tx 0xee583c74 on Arbitrum, an ETH short
// liquidated on 2026-09-29. Three of its figures were verified outside the
// squid before the expectations below were written:
//
//   - collateral: initialCollateralDeltaAmount is 39,512,118 units of USDC and
//     collateralTokenPriceMin is 999971002500000000000000, so the margin is
//     39.5110 dollars. The same figure appears as the collateral delta of the
//     immediately preceding increase on the same positionKey, which is the
//     independent confirmation that this field is the position's whole margin
//     on a liquidation row rather than a requested withdrawal.
//   - loss at trigger: basePnlUsd is -25.9145 dollars, 65.59% of the margin.
//   - returned: collateral plus pnlUsd is 8.6551 dollars, and the transaction
//     transferred 8.655363 USDC to the liquidated account
//     0x3BA3893fDe7e06EAF13a4C06e190147b867c82fB. Across twelve of the largest
//     liquidations of the 24h to 2026-09-29 the predicted residual matched an
//     on-chain transfer of that exact amount in seven; the other five were
//     cross-chain orders whose payout the pool sent to a GMX vault instead of
//     to the account, for the same amount.
//
// So GMX is the venue that shows the metric is not a constant of the industry:
// it pays the residual back, and its median forfeit over that day was 15.4
// points against Gains' 40.0.

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// gmxLiqSquid stands up a squid that answers the liquidation query with the
// given rows and the market list with one ETH market at that address.
func gmxLiqSquid(t *testing.T, market string, rows []map[string]any) (*GMX, func()) {
	t.Helper()
	squid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct{ Query string }
		_ = json.Unmarshal(body, &req)
		out := rows
		// Pagination: only the first page carries rows.
		if strings.Contains(req.Query, "offset:500") {
			out = nil
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{"tradeActions": out},
		})
	}))
	info := buildGMXInfoServer(t, []map[string]any{
		gmxMarketEntry("ETH/USD [ETH-USDC]", market, true, gmxOI5000, gmxOI3000),
	})
	g := &GMX{marketsURL: info.URL, squidURL: squid.URL}
	return g, func() { squid.Close(); info.Close() }
}

// The real row, field for field.
func gmxGoldenLiquidationRow(market string) map[string]any {
	return map[string]any{
		"marketAddress":                market,
		"orderKey":                     "0xae235265b255d90c061564212176072c32cae85ec740e48a956b037ee9e9a751",
		"transactionHash":              "0xee583c7485d4d7dd102a69b5af0c54faa90df3fdf00781576abb7b9629036b99",
		"timestamp":                    1790670132,
		"sizeDeltaUsd":                 "1283888961825329820125750000000000",
		"initialCollateralDeltaAmount": "39512118",
		"collateralTokenPriceMin":      "999971002500000000000000",
		"basePnlUsd":                   "-25914543346411617673988950000000",
		"pnlUsd":                       "-30855859970892757989842008080301",
	}
}

func TestGMXForfeit_GoldenLiquidationRow(t *testing.T) {
	const market = "0xBcb8FE13d02b023e8f94f6881Cc0192fd918A5C0"
	g, done := gmxLiqSquid(t, market, []map[string]any{gmxGoldenLiquidationRow(market)})
	defer done()

	evs, err := g.FetchLiquidationsSince("ETH", 1790600000000)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	e := evs[0]
	if math.Abs(e.NotionalUSD-1283.889) > 0.01 {
		t.Fatalf("notional = %.4f, want 1283.889", e.NotionalUSD)
	}
	if !e.HasForfeitDetail {
		t.Fatal("a row carrying collateral, base P&L and all-in P&L must carry the detail")
	}
	if math.Abs(e.CollateralUSD-39.5110) > 0.001 {
		t.Fatalf("collateral = %.4f, want 39.5110", e.CollateralUSD)
	}
	if math.Abs(e.Leverage-32.49) > 0.01 {
		t.Fatalf("leverage = %.2f, want 32.49 (notional over margin)", e.Leverage)
	}
	if math.Abs(e.LossAtTriggerPct-65.588) > 0.01 {
		t.Fatalf("loss at trigger = %.3f%%, want 65.588%%", e.LossAtTriggerPct)
	}
	// The number the chain confirmed: 8.655363 USDC to the liquidated account.
	if math.Abs(e.ReturnedUSD-8.6551) > 0.005 {
		t.Fatalf("returned = %.4f, want 8.6551 (the tx transferred 8.655363 USDC)", e.ReturnedUSD)
	}

	w := NewSlidingWindow(windowSpan)
	w.AddEvent(e)
	forf, loss, ret, n := w.ForfeitStats()
	if n != 1 {
		t.Fatalf("window counted %d forfeit events, want 1", n)
	}
	if math.Abs(loss-65.588) > 0.01 || math.Abs(ret-21.906) > 0.01 || math.Abs(forf-12.506) > 0.02 {
		t.Fatalf("shares = loss %.3f returned %.3f forfeited %.3f, want 65.588 / 21.906 / 12.506",
			loss, ret, forf)
	}
}

// GMX prices collateral per smallest unit at 1e30, so the USD figure needs no
// token decimals at all. Dividing by 1e30 alone, or looking the decimals up and
// dividing twice, is off by 1e6 on USDC and by 1e18 on WETH.
func TestGMXForfeit_CollateralNeedsNoDecimals(t *testing.T) {
	usdc, err := gmxCollateralUSD("39512118", "999971002500000000000000")
	if err != nil {
		t.Fatalf("usdc: %v", err)
	}
	if math.Abs(usdc-39.5110) > 0.001 {
		t.Fatalf("39.512118 USDC priced at %.4f, want 39.5110", usdc)
	}
	// One WETH, an 18-decimal token, at 2,700 dollars: 1e18 units at a price of
	// 2700 * 1e30 / 1e18 = 2.7e15.
	weth, err := gmxCollateralUSD("1000000000000000000", "2700000000000000")
	if err != nil {
		t.Fatalf("weth: %v", err)
	}
	if math.Abs(weth-2700) > 0.01 {
		t.Fatalf("one WETH priced at %.2f, want 2700", weth)
	}
	if _, err := gmxCollateralUSD("", "999971002500000000000000"); err == nil {
		t.Fatal("a row with no collateral amount should be refused, not read as zero")
	}
}

// A row the squid returns without the position fields keeps its notional and
// stays out of the forfeited arithmetic. Reading it as a zero-collateral event
// would make GMX's forfeit 100 points on rows nobody measured.
func TestGMXForfeit_RowWithoutPositionFieldsPublishesNotionalOnly(t *testing.T) {
	const market = "0xBcb8FE13d02b023e8f94f6881Cc0192fd918A5C0"
	row := gmxGoldenLiquidationRow(market)
	delete(row, "initialCollateralDeltaAmount")
	delete(row, "collateralTokenPriceMin")
	g, done := gmxLiqSquid(t, market, []map[string]any{row})
	defer done()

	evs, err := g.FetchLiquidationsSince("ETH", 1790600000000)
	if err != nil || len(evs) != 1 {
		t.Fatalf("fetch (%d events): %v", len(evs), err)
	}
	if evs[0].NotionalUSD <= 0 {
		t.Fatal("the notional should still publish")
	}
	if evs[0].HasForfeitDetail || evs[0].CollateralUSD != 0 {
		t.Fatal("a row with no collateral must not carry the forfeited detail")
	}
	w := NewSlidingWindow(windowSpan)
	w.AddEvent(evs[0])
	if _, _, _, n := w.ForfeitStats(); n != 0 {
		t.Fatalf("window counted %d forfeit events, want 0", n)
	}
}

// A liquidation whose price P&L was positive is excluded on GMX for the same
// reason as on Gains: it is not a trader losing money to a move.
func TestGMXForfeit_RefusesPriceProfitOnALiquidation(t *testing.T) {
	const market = "0xBcb8FE13d02b023e8f94f6881Cc0192fd918A5C0"
	row := gmxGoldenLiquidationRow(market)
	row["basePnlUsd"] = "25914543346411617673988950000000" // the same figure, positive
	g, done := gmxLiqSquid(t, market, []map[string]any{row})
	defer done()
	evs, err := g.FetchLiquidationsSince("ETH", 1790600000000)
	if err != nil || len(evs) != 1 {
		t.Fatalf("fetch (%d events): %v", len(evs), err)
	}
	if evs[0].HasForfeitDetail {
		t.Fatal("a liquidation at a price profit entered the forfeited arithmetic")
	}
}

// The volume query must not ask for the position fields: it pages over a few
// thousand rows and the squid refuses a response it judges too large, which
// would take the rank denominator out for both GMX rows.
func TestGMXForfeit_VolumeQueryKeepsItsFieldListNarrow(t *testing.T) {
	if strings.Contains(gmxFieldsSize, "basePnlUsd") ||
		strings.Contains(gmxFieldsSize, "initialCollateralDeltaAmount") {
		t.Fatal("the volume selection must stay narrow")
	}
	for _, f := range []string{"initialCollateralDeltaAmount", "collateralTokenPriceMin", "basePnlUsd", "pnlUsd"} {
		if !strings.Contains(gmxFieldsPosition, f) {
			t.Fatalf("the liquidation selection is missing %s", f)
		}
	}
}
