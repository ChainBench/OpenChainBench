package main

import (
	"context"
	"encoding/binary"
	"math"
	"math/big"
	"strings"
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

func TestPooledSplitIgnoresRowsTheBoundsThrewOut(t *testing.T) {
	loss := 300.0
	priced := func(term string, fee float64) Swap {
		return Swap{Terminal: term, Method: methodVersion, Priced: true, LossBps: &loss, TerminalBps: fee, NetworkBps: 5}
	}
	st := &State{Swaps: []Swap{
		priced("gmgn", 98), priced("gmgn", 100), priced("gmgn", 99),
		priced("gmgn-arc", 97), priced("gmgn-arc", 96),
		// The doubled Arc buys: unpriced, out of bounds, fee residual 5,050 bps.
		{Terminal: "gmgn-arc", Method: methodVersion, Flag: "out_of_bounds", TerminalBps: 5050, NetworkBps: 1},
		{Terminal: "gmgn-arc", Method: methodVersion, Flag: "out_of_bounds", TerminalBps: 5047, NetworkBps: 1},
		{Terminal: "gmgn-arc", Method: methodVersion, Flag: "out_of_bounds", TerminalBps: 5033, NetworkBps: 1},
	}}
	member := map[string]bool{"gmgn": true, "gmgn-arc": true}
	att := map[string]float64{"gmgn": 400000, "gmgn-arc": 20000}
	cm := chainMeanOfMedians(st, member, []string{"gmgn", "gmgn-arc"}, att, c2field, nil)
	if v := cm["terminal"]; v < 96 || v > 100 {
		t.Errorf("pooled terminal follows rows the bounds threw out: %.1f bps", v)
	}
}

func TestArcTwinLogsAreCountedOnce(t *testing.T) {
	const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
	pad := func(a string) string { return "0x000000000000000000000000" + strings.TrimPrefix(a, "0x") }
	router, user := "0x40fe100d34b6a552d49ad8cc252795ccead48277", "0x3de52da320b4bdf27423bb5d03d51af4b8fb8c65"
	hex := func(v string) string {
		n, _ := new(big.Int).SetString(v, 10)
		return "0x" + strings.Repeat("0", 64-len(n.Text(16))) + n.Text(16)
	}
	logs := []evmLog{
		{Address: arcPseudo, Topics: []string{transfer, pad(router), pad(user)}, Data: hex("13156612000000000000")},
		{Address: arcUSDC, Topics: []string{transfer, pad(router), pad(user)}, Data: hex("13156612")},
		// A native payment: the pseudo-token alone, no twin, must stay.
		{Address: arcPseudo, Topics: []string{transfer, pad(router), pad("0x9d3a55e414617d62b66819b391245755ebcfb467")}, Data: hex("141168579750000000000")},
	}
	twins := arcTwins("arc", logs)
	if !twins[0] || twins[1] || twins[2] {
		t.Errorf("twins: %v (want the first pseudo-token log alone)", twins)
	}
	if arcTwins("base", logs) != nil {
		t.Errorf("a chain other than Arc has no twins")
	}
}

func TestConcentratedPriceIsOrientedByTheTradeItself(t *testing.T) {
	// A memecoin pool: 1.2e-7 raw quote per raw token. The event's price and
	// its inverse are 1e14 apart, so the trade's own execution names which
	// way round the pool's tokens are.
	ev := []concSqrt{{post: 1.2e-7}}
	pre, post, ok := pickConc(ev, 1.25e-7)
	if !ok || post != 1.2e-7 || pre != 0 {
		t.Errorf("straight orientation: pre=%g post=%g ok=%v", pre, post, ok)
	}
	if _, post, ok := pickConc([]concSqrt{{post: 1 / 1.2e-7}}, 1.25e-7); !ok || math.Abs(post-1.2e-7)/1.2e-7 > 1e-9 {
		t.Errorf("inverted orientation: post=%g ok=%v", post, ok)
	}
	// Two pools of the same venue in one route: no reference rather than a guess.
	if _, _, ok := pickConc([]concSqrt{{post: 1.2e-7}, {post: 1.3e-7}}, 1.25e-7); ok {
		t.Errorf("an ambiguous route still produced a reference")
	}
	// A price near one is its own near-inverse: also an ambiguity.
	if _, _, ok := pickConc([]concSqrt{{post: 1.1}}, 1.05); ok {
		t.Errorf("a price beside its own inverse still produced a reference")
	}
	// Out of band: not this pool's event.
	if _, _, ok := pickConc([]concSqrt{{post: 1.2e-7}}, 9e-7); ok {
		t.Errorf("an event from another pool was accepted")
	}
}

func TestQ64ReadsASquareRootPrice(t *testing.T) {
	// sqrt(4) in Q64.64 is 2 << 64, so the price reads 4.
	b := make([]byte, 16)
	binary.LittleEndian.PutUint64(b[8:], 2)
	if v := q64(b); math.Abs(v-4) > 1e-9 {
		t.Errorf("q64 = %g, want 4", v)
	}
	if v := q64(b[:8]); v != 0 {
		t.Errorf("q64 of a short slice = %g, want 0", v)
	}
}

func TestTheRouteOwnRateBeatsTheExchangePrintOnAGasCoinLeg(t *testing.T) {
	const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
	whype, usdc := "0x5555555555555555555555555555555555555555", "0xb88339cb7199b77e23db6e890353e22632ba630f"
	c := originChain{id: 999, slug: "tfqtest", gas: "HYPE-USD"}
	erc20Cache.Lock()
	erc20Cache.m[c.slug+":"+whype] = erc20Meta{dec: 18, symbol: "WHYPE", ok: true}
	erc20Cache.m[c.slug+":"+usdc] = erc20Meta{dec: 6, symbol: "USDC", ok: true}
	erc20Cache.Unlock()
	gas := map[string]float64{"HYPE-USD": 91.6465}
	pad := func(a string) string { return "0x000000000000000000000000" + strings.TrimPrefix(a, "0x") }
	hexw := func(v string) string {
		n, _ := new(big.Int).SetString(v, 10)
		h := n.Text(16)
		return "0x" + strings.Repeat("0", 64-len(h)) + h
	}
	router, hop := "0x8f10b468b06c6fd214b65f87778827f7d113f996", "0x1c8ee7e99e2aecd1338e111716e4744e7d088098"
	amount, _ := new(big.Int).SetString("40890574179911198", 10)
	logs := []evmLog{
		{Address: whype, Topics: []string{transfer, pad(router), pad(hop)}, Data: hexw("40890574179911198")},
		{Address: usdc, Topics: []string{transfer, pad(hop), pad(router)}, Data: hexw("3755514")},
	}
	exchange := 91.6465 * math.Pow10(-18)
	r, ok := routeGasRate(context.Background(), nil, c, logs, gas, whype, amount, exchange)
	if !ok {
		t.Fatalf("the route's own conversion was not read")
	}
	// 3.755514 USDC for 0.040890574179911198 WHYPE is 91.8425 a coin, 21 bps
	// over the exchange print the row was valued at.
	if got := r * math.Pow10(18); math.Abs(got-91.8425) > 0.001 {
		t.Errorf("rate = %.4f USD a coin, want 91.8425", got)
	}
	// A stable coming back from somewhere else is not this leg's counterparty.
	other := []evmLog{logs[0], {Address: usdc, Topics: []string{transfer, pad("0x00000000000000000000000000000000000000aa"), pad(router)}, Data: hexw("3755514")}}
	if _, ok := routeGasRate(context.Background(), nil, c, other, gas, whype, amount, exchange); ok {
		t.Errorf("a stable from an unrelated address was taken for the hop")
	}
	// Far from the exchange print: basis is corrected, a price is not invented.
	far := []evmLog{logs[0], {Address: usdc, Topics: []string{transfer, pad(hop), pad(router)}, Data: hexw("9000000")}}
	if _, ok := routeGasRate(context.Background(), nil, c, far, gas, whype, amount, exchange); ok {
		t.Errorf("a rate twice the exchange's was accepted")
	}
}
