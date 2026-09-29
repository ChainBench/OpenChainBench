package main

// source_ostium_forfeit_test.go: the Ostium forfeited-collateral decode pinned
// against a real subgraph row and against the chain.
//
// The row is tx 0xfa67b49b, a BTC position liquidated on Arbitrum. What was
// checked outside the subgraph before these expectations were written:
//
//   - trade.collateral is 1,516,842,000 at 6 decimals, 1,516.842 dollars, and
//     the transaction's two USDC transfers out of the trading storage
//     (177.663331 and 1,339.180869) total 1,516.8442: the whole margin left the
//     position, and both legs went to the vault at 0x20d419a8, none to the
//     trader. amountSentToTrader reading "0" is therefore the truth and not an
//     unread field. It read zero on 91 of 91 liquidations over the 7 days to
//     2026-09-29.
//   - trade.leverage is 1e2 fixed point, not the 1e3 Gains uses. The row reads
//     5000 and trade.notional / trade.collateral is 50.00.
//   - profitPercent is 1e6 fixed point and signed: -88014938 is -88.014938%,
//     which (closePrice - openPrice) / openPrice x leverage reproduces. The same
//     identity held on 91 of 91 rows.

import (
	"math"
	"testing"
)

// The real row.
func ostiumGoldenLiquidationRow() map[string]any {
	return map[string]any{
		"id":                 "0xfa67b49bf29c1f8824a47e2a95a57a84924ae00dd4520b5533040c23c8e0e4fb-17",
		"timestamp":          "1790500000",
		"profitPercent":      "-88014938",
		"amountSentToTrader": "0",
		"pair":               map[string]any{"from": "BTC"},
		"trade": map[string]any{
			"notional":   "75842100000", // $75,842.10 at 50x
			"collateral": "1516842000",  // $1,516.842
			"leverage":   "5000",        // 50.00x
		},
	}
}

func TestOstiumForfeit_GoldenLiquidationRow(t *testing.T) {
	o, _, done := ostiumStub(t, []map[string]any{ostiumGoldenLiquidationRow()}, nil, nil)
	defer done()

	evs, err := o.FetchLiquidationsSince("BTC", 1790400000000)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	e := evs[0]
	if !e.HasForfeitDetail {
		t.Fatal("a row whose linked trade carries the collateral must carry the detail")
	}
	if math.Abs(e.CollateralUSD-1516.842) > 0.001 {
		t.Fatalf("collateral = %.4f, want 1516.842", e.CollateralUSD)
	}
	// 1e2, not 1e3: read at the Gains scale this is 5x and the whole band
	// breakdown moves to the wrong band.
	if math.Abs(e.Leverage-50) > 1e-9 {
		t.Fatalf("leverage = %.4f, want 50 (Ostium writes 5000 for 50x)", e.Leverage)
	}
	if math.Abs(e.NotionalUSD/e.CollateralUSD-e.Leverage) > 0.01 {
		t.Fatalf("notional / collateral = %.4f, want the leverage %.4f",
			e.NotionalUSD/e.CollateralUSD, e.Leverage)
	}
	if math.Abs(e.LossAtTriggerPct-88.014938) > 1e-6 {
		t.Fatalf("loss at trigger = %.6f%%, want 88.014938%%", e.LossAtTriggerPct)
	}
	if e.ReturnedUSD != 0 {
		t.Fatalf("returned = %.6f, want 0: both USDC legs of this tx went to the vault", e.ReturnedUSD)
	}

	w := NewSlidingWindow(windowSpan)
	w.AddEvent(e)
	forf, loss, ret, n := w.ForfeitStats()
	if n != 1 {
		t.Fatalf("window counted %d forfeit events, want 1", n)
	}
	if math.Abs(loss-88.014938) > 1e-6 || ret != 0 || math.Abs(forf-11.985062) > 1e-6 {
		t.Fatalf("shares = loss %.6f returned %.6f forfeited %.6f, want 88.014938 / 0 / 11.985062",
			loss, ret, forf)
	}
	if got := leverageBandOf(e.Leverage); got != "25-50x" {
		t.Fatalf("50x landed in band %q, want 25-50x (the bound is inclusive)", got)
	}
}

// The subgraph's own collateralDelta, leverage and notional are null on a
// liquidation row; only the linked trade carries them. A row with no linked
// trade keeps its notional out of the forfeited arithmetic rather than reading
// as a position that forfeited everything.
func TestOstiumForfeit_RowWithoutALinkedTradeCarriesNoDetail(t *testing.T) {
	row := ostiumGoldenLiquidationRow()
	row["trade"] = map[string]any{"notional": "75842100000"}
	o, _, done := ostiumStub(t, []map[string]any{row}, nil, nil)
	defer done()
	evs, err := o.FetchLiquidationsSince("BTC", 1790400000000)
	if err != nil || len(evs) != 1 {
		t.Fatalf("fetch (%d events): %v", len(evs), err)
	}
	if evs[0].NotionalUSD <= 0 {
		t.Fatal("the notional should still publish")
	}
	if evs[0].HasForfeitDetail {
		t.Fatal("a row with no collateral must not carry the forfeited detail")
	}
}

// Ostium closes on total equity including carry, so a row can read a price loss
// above 100% of the margin: one of the 91 over 7 days read 116.0%. The trader
// forfeited nothing beyond their loss there, and the published figure is 0
// rather than a negative number that would read as money handed back.
func TestOstiumForfeit_LossAboveTheMarginForfeitsNothing(t *testing.T) {
	row := ostiumGoldenLiquidationRow()
	row["profitPercent"] = "-116000000" // -116%
	o, _, done := ostiumStub(t, []map[string]any{row}, nil, nil)
	defer done()
	evs, err := o.FetchLiquidationsSince("BTC", 1790400000000)
	if err != nil || len(evs) != 1 {
		t.Fatalf("fetch (%d events): %v", len(evs), err)
	}
	w := NewSlidingWindow(windowSpan)
	w.AddEvent(evs[0])
	forf, loss, _, n := w.ForfeitStats()
	if n != 1 {
		t.Fatalf("window counted %d forfeit events, want 1", n)
	}
	if loss != 100 {
		t.Fatalf("loss = %.4f, want it clamped to 100", loss)
	}
	if forf != 0 {
		t.Fatalf("forfeited = %.4f, want 0 rather than a negative share", forf)
	}
}

// A liquidation row whose price return was positive is excluded, as on the other
// two venues.
func TestOstiumForfeit_RefusesPriceProfitOnALiquidation(t *testing.T) {
	row := ostiumGoldenLiquidationRow()
	row["profitPercent"] = "12000000" // +12%
	o, _, done := ostiumStub(t, []map[string]any{row}, nil, nil)
	defer done()
	evs, err := o.FetchLiquidationsSince("BTC", 1790400000000)
	if err != nil || len(evs) != 1 {
		t.Fatalf("fetch (%d events): %v", len(evs), err)
	}
	if evs[0].HasForfeitDetail {
		t.Fatal("a liquidation at a price profit entered the forfeited arithmetic")
	}
}
