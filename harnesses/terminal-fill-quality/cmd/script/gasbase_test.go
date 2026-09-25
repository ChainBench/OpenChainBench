package main

import (
	"math"
	"testing"
)

// The gas belongs in what the user gave exactly once. Where it is paid in
// the quote asset it is already inside the user's own quote movement;
// where it is paid in something else it has to be added, or the split
// subtracts a cost the base was never charged and the pool goes negative.
//
// The first case is the decoded swap 3395mNiAz6: 3.00 USDC and 0.001764
// SOL ($0.2064) given, tokens worth $2.944 received. It published a loss
// of 187 bps against a base of 3.00 while the split charged 688 bps of
// network against it, leaving a pool of -586.
func TestGasEntersTheBaseOnceOnly(t *testing.T) {
	ref := func(v float64) *float64 { return &v }
	for _, c := range []struct {
		name      string
		sw        Swap
		ref       float64
		wantTrade float64
		wantPool  string // "positive" where the case exists to prove the sign
	}{{
		name: "solana buy quoted in a stable: the gas is outside the quote leg",
		sw: Swap{Side: "buy", Quote: "USDC", QuoteUSD: 1,
			Tokens: 2.944, UserQ: 3.00, NetworkQ: 0.2064, TerminalQ: 0.0255},
		ref: 1, wantTrade: 3.2064, wantPool: "positive",
	}, {
		name: "solana buy quoted in SOL: the lamport delta already carries it",
		sw: Swap{Side: "buy", Quote: "SOL", QuoteUSD: 117,
			Tokens: 2.944, UserQ: 0.02565, NetworkQ: 0.001764, TerminalQ: 0.000218},
		ref: 0.008547, wantTrade: 0.02565,
	}, {
		name: "solana sell quoted in a stable: the gas is paid apart from the tokens",
		sw: Swap{Side: "sell", Quote: "USDC", QuoteUSD: 1,
			Tokens: 3.00, UserQ: 2.90, NetworkQ: 0.2064, TerminalQ: 0.0255},
		ref: 1, wantTrade: 3.2064,
	}, {
		name: "evm buy: the leg was built with the gas already inside",
		sw: Swap{Side: "buy", Chain: "base", Quote: "USDC", QuoteUSD: 1,
			Tokens: 2.944, UserQ: 3.2064, NetworkQ: 0.2064, TerminalQ: 0.0255},
		ref: 1, wantTrade: 3.2064,
	}} {
		t.Run(c.name, func(t *testing.T) {
			sw := c.sw
			sw.finalize(ref(c.ref), 0, "test")
			if !sw.Priced {
				t.Fatalf("row did not price: flag %q", sw.Flag)
			}
			if got := sw.TradeUSD / sw.QuoteUSD; math.Abs(got-c.wantTrade) > 1e-6 {
				t.Errorf("base = %.6f, want %.6f", got, c.wantTrade)
			}
			if c.wantPool == "positive" && *sw.PoolBps <= 0 {
				t.Errorf("pool = %.0f bps, want positive: the base carries the gas "+
					"the split charges (loss %.0f, network %.0f)",
					*sw.PoolBps, *sw.LossBps, sw.NetworkBps)
			}
			// Whatever the base, the four components account for the loss.
			other := 0.0
			if sw.OtherQ != nil {
				other = *sw.OtherQ
			}
			sum := *sw.PoolBps + sw.TerminalBps + sw.NetworkBps + sw.RelayBps +
				1e4*other/(sw.TradeUSD/sw.QuoteUSD)
			if math.Abs(sum-*sw.LossBps) > 0.01 {
				t.Errorf("components sum to %.2f bps, loss is %.2f", sum, *sw.LossBps)
			}
		})
	}
}
