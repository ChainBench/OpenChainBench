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
			Tokens: 2.944, UserQ: 3.00, NetworkQ: 0.2064, UserSolQ: 0.2064, TerminalQ: 0.0255},
		ref: 1, wantTrade: 3.2064, wantPool: "positive",
	}, {
		// A relayer signed and funded: the user spent no SOL, and the gas
		// is already inside the quote they handed over. Adding it here
		// would charge them for it twice.
		name: "solana buy quoted in a stable, gas sponsored: the base is the quote alone",
		sw: Swap{Side: "buy", Quote: "USDC", QuoteUSD: 1,
			Tokens: 2.944, UserQ: 3.00, NetworkQ: 0.2064, UserSolQ: 0, TerminalQ: 0.0255},
		ref: 1, wantTrade: 3.00,
	}, {
		name: "solana buy quoted in SOL: the lamport delta already carries it",
		sw: Swap{Side: "buy", Quote: "SOL", QuoteUSD: 117,
			Tokens: 2.944, UserQ: 0.02565, NetworkQ: 0.001764, TerminalQ: 0.000218},
		ref: 0.008547, wantTrade: 0.02565,
	}, {
		name: "solana sell quoted in a stable: the gas is paid apart from the tokens",
		sw: Swap{Side: "sell", Quote: "USDC", QuoteUSD: 1,
			Tokens: 3.00, UserQ: 2.90, NetworkQ: 0.2064, UserSolQ: 0.2064, TerminalQ: 0.0255},
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

// loadState recomputes the v3 rows in place rather than dropping them,
// which is only safe if finalize depends on nothing it destroys: it must
// give the same answer run twice on the row it just wrote, from the
// reference the row carries.
func TestFinalizeIsIdempotentOnItsOwnOutput(t *testing.T) {
	ref := 1.0
	for _, sw := range []Swap{
		{Side: "buy", Quote: "USDC", QuoteUSD: 1, Tokens: 2.944, UserQ: 3.00, NetworkQ: 0.2064, UserSolQ: 0.2064, TerminalQ: 0.0255},
		{Side: "buy", Quote: "USDC", QuoteUSD: 1, Tokens: 2.944, UserQ: 3.00, NetworkQ: 0.2064, UserSolQ: 0, TerminalQ: 0.0255},
		{Side: "sell", Quote: "SOL", QuoteUSD: 117, Tokens: 3.00, UserQ: 0.0244, NetworkQ: 0.0018, TerminalQ: 0.0002},
		{Side: "buy", Chain: "bnb", Quote: "USDC", QuoteUSD: 1, Tokens: 2.9, UserQ: 3.2, NetworkQ: 0.2, TerminalQ: 0.03},
	} {
		sw.finalize(&ref, 3, "pool")
		first := sw
		// Replayed the way loadState replays it: the row's own stored
		// reference, age and source, with nothing re-read from the chain.
		sw.finalize(sw.RefPrice, *sw.RefAgeS, sw.RefSrc)
		if sw.TradeUSD != first.TradeUSD || *sw.LossBps != *first.LossBps || *sw.PoolBps != *first.PoolBps {
			t.Errorf("%s %s replayed differently: trade %.6f->%.6f, loss %.3f->%.3f, pool %.3f->%.3f",
				sw.Side, sw.Quote, first.TradeUSD, sw.TradeUSD,
				*first.LossBps, *sw.LossBps, *first.PoolBps, *sw.PoolBps)
		}
		if sw.Priced != first.Priced || sw.Flag != first.Flag {
			t.Errorf("%s %s changed state on replay: priced %v->%v, flag %q->%q",
				sw.Side, sw.Quote, first.Priced, sw.Priced, first.Flag, sw.Flag)
		}
	}
}

// An unpriced row has no reference to replay. It must survive the same
// call without acquiring figures it never had.
func TestFinalizeReplayLeavesAnUnpricedRowUnpriced(t *testing.T) {
	sw := Swap{Side: "buy", Quote: "USDC", QuoteUSD: 1, Tokens: 2.9, UserQ: 3.0, NetworkQ: 0.2}
	sw.finalize(nil, 0, "")
	trade := sw.TradeUSD
	sw.finalize(sw.RefPrice, 0, sw.RefSrc) // RefPrice is nil, as loadState would pass it
	if sw.Priced || sw.LossBps != nil || sw.PoolBps != nil {
		t.Errorf("an unpriced row acquired figures on replay: priced=%v loss=%v pool=%v", sw.Priced, sw.LossBps, sw.PoolBps)
	}
	if sw.TradeUSD != trade {
		t.Errorf("trade size moved on replay: %.6f -> %.6f", trade, sw.TradeUSD)
	}
}

// finalize clears Flag and sets Priced again on its first lines, so any
// path that replays it un-drops a row the split guard had dropped. That is
// how the window came to hold seven rows below -200 bps and three terminal
// fees above 1000 with not one of them carrying the flag.
func TestReplayKeepsAnImplausibleSplitDropped(t *testing.T) {
	ref := 1.0
	// The named costs come to far more than the trade lost, so the pool
	// residual is deeply negative: the split cannot be right.
	sw := Swap{Side: "buy", Quote: "USDC", QuoteUSD: 1,
		Tokens: 2.99, UserQ: 3.00, TerminalQ: 1.90, NetworkQ: 0.05}
	sw.finalize(&ref, 0, "reserves")
	implausibleSplit(&sw)
	if sw.Priced || sw.Flag != "split_implausible" {
		t.Fatalf("the guard did not drop the row: priced=%v flag=%q", sw.Priced, sw.Flag)
	}
	// Replayed the way loadState replays it.
	sw.finalize(sw.RefPrice, *sw.RefAgeS, sw.RefSrc)
	if sw.Flag != "" || !sw.Priced {
		t.Fatalf("finalize no longer clears the flag, so this test guards the "+
			"wrong thing now: flag=%q priced=%v", sw.Flag, sw.Priced)
	}
	implausibleSplit(&sw)
	if sw.Priced || sw.Flag != "split_implausible" {
		t.Errorf("the row came back priced after a replay: flag=%q priced=%v pool=%.0f",
			sw.Flag, sw.Priced, *sw.PoolBps)
	}
}

func TestReplayKeepsAnOriginTokenRowOutOfTheCount(t *testing.T) {
	ref := 1.0
	sw := Swap{Side: "buy", Quote: "USDC", QuoteUSD: 1, Method: 4,
		Tokens: 2.99, UserQ: 3.00, TerminalQ: 0.03, NetworkQ: 0.01}
	sw.finalize(&ref, 0, "reserves")
	sw.Flag, sw.Priced = "origin_token", false // as the Relay path stores it
	replayFinalize(&sw)
	if sw.Priced || sw.Flag != "origin_token" || sw.Method != methodVersion {
		t.Errorf("a replay counted a row paid in a token on the origin chain: flag=%q priced=%v method=%d", sw.Flag, sw.Priced, sw.Method)
	}
	// A flag finalize itself sets is re-derived, not restored: a row the
	// guard dropped under the old arithmetic may be sound under the new.
	ok := Swap{Side: "buy", Quote: "USDC", QuoteUSD: 1, Method: 4,
		Tokens: 2.99, UserQ: 3.00, TerminalQ: 0.03, NetworkQ: 0.01, Flag: "split_implausible"}
	ok.RefPrice = &ref
	replayFinalize(&ok)
	if !ok.Priced || ok.Flag != "" {
		t.Errorf("a sound row stayed dropped through a replay: flag=%q priced=%v", ok.Flag, ok.Priced)
	}
}

func TestLearnedDepthNeverGoesUnderTheDefaultSpanAndGrowsBack(t *testing.T) {
	f := &nativeFeed{depth: map[string]int64{}, span: map[string]int64{}}
	f.learnDepth("bnb", 15999) // learned while the span sat collapsed at 10
	if d := f.depth["bnb"]; d != 7999 {
		t.Fatalf("depth after one refusal: %d", d)
	}
	f.learnDepth("bnb", 30) // a refusal 30 blocks behind cannot floor the depth under a default span
	if d := f.depth["bnb"]; d != f.spanDefault("bnb") {
		t.Errorf("depth floored at the collapsed span, not the default: %d", d)
	}
	f.growDepth("bnb", 16000)
	f.growDepth("bnb", 16000)
	if d := f.depth["bnb"]; d != f.spanDefault("bnb")*4 {
		t.Errorf("depth did not double per clean poll: %d", d)
	}
	for i := 0; i < 8; i++ {
		f.growDepth("bnb", 16000)
	}
	if _, ok := f.depth["bnb"]; ok {
		t.Errorf("a depth back at the budget is still remembered: %d", f.depth["bnb"])
	}
}
