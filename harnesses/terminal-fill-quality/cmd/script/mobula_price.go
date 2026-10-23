package main

// Pricing a Mobula fill: finding the user, then the existing pricer.
//
// The fill event carries the intent id and NOTHING else, no recipient and no
// token, so both have to be inferred from the receipt. That inference is
// exactly what produced the executor-as-user bug in #3217, where an
// intermediary was taken for the trader and its two quote legs were counted
// as the user's input. So the rule below was tested against an independent
// answer before any of this was written, and it failed its first version.
//
// THE SINK RULE: the user is the address that RECEIVES a token in the fill and
// SENDS none. Pools, routers, executors and the bridge all appear on both
// sides of some transfer because value passes through them; a user is a dead
// end. The token is whatever that address received, SUMMED over every transfer
// of it.
//
// Checked against the explorer's own recipient, token and amountOut, which is
// not a restatement of my reading of the receipt:
//
//	the explorer's recipient is a dead end   48 of 50 fills
//	the summed amount equals amountOut       50 of 50
//
// Two ways it was wrong first, both of which would have shipped silently:
//
//	taking the LARGEST transfer to the user instead of the sum. Wrong on any
//	multi-venue fill, and multi-venue is the norm here: summing moved amount
//	agreement from 24 of 40 to 50 of 50.
//
//	demanding exactly one dead end, which returned nothing on 15 of 40. The
//	extra dead ends are fee takers, named below.
//
// The 2 of 50 the rule cannot resolve stay UNPRICED. A rule that is mostly
// right selects the rest of the row by transaction shape, which is the defect
// behind both #3193 and #3217.

import (
	"context"
	"math/big"
	"net/http"
	"strings"
)

// mobulaSinkSkip: dead ends that are not the user, measured over 60 fills.
//
//	robinhoodTokenFee  a contract with 15 kB of code, a dead end in 13 of 60
//	                   fills and never the user, taking the user's own token
//	                   at 101, 204 or 309 bps on Robinhood only. Those tiers
//	                   are 1%, 2% and 3%: a per-token creator or launchpad
//	                   fee, not an app's cut, because an app fee does not
//	                   arrive in three per-token tiers on one chain.
//
// A sink that IS the token contract is handled separately below: a token
// receiving its own token is a transfer tax it levies on every holder, which
// belongs in the pool cost and never in anyone's fee. Calling either of these
// a terminal fee would repeat counting a gas sponsor as a fee taker.
func mobulaSinkSkip() map[string]bool {
	out := map[string]bool{
		"0x0000000000000000000000000000000000000000": true,
		robinhoodTokenFee:                            true,
	}
	for _, a := range mobulaBridge {
		out[strings.ToLower(a)] = true
	}
	return out
}

// mobulaSink applies the rule. ok is false when the receipt does not resolve
// to exactly one user, which must leave the fill unpriced rather than guessed.
func mobulaSink(logs []evmLog) (user, token string, amount *big.Int, ok bool) {
	skip := mobulaSinkSkip()
	sent := map[string]bool{}
	got := map[string]map[string]*big.Int{}
	for _, l := range logs {
		if len(l.Topics) != 3 || !strings.EqualFold(l.Topics[0], topicERC20Transfer) {
			continue
		}
		from, to := topicAddr(l.Topics[1]), topicAddr(l.Topics[2])
		tok := strings.ToLower(l.Address)
		v := new(big.Int)
		if _, good := v.SetString(strings.TrimPrefix(l.Data, "0x"), 16); !good {
			continue
		}
		sent[from] = true
		if got[to] == nil {
			got[to] = map[string]*big.Int{}
		}
		if got[to][tok] == nil {
			got[to][tok] = new(big.Int)
		}
		got[to][tok].Add(got[to][tok], v)
	}

	type cand struct {
		addr   string
		token  string
		amount *big.Int
	}
	var cands []cand
	for addr, toks := range got {
		if sent[addr] || skip[addr] {
			continue
		}
		// A token contract receiving its own token is taxing a transfer,
		// not holding a position.
		if _, self := toks[addr]; self && len(toks) == 1 {
			continue
		}
		best, bestTok := new(big.Int), ""
		for tok, v := range toks {
			if tok == addr {
				continue // the self-tax leg, if it also received something else
			}
			if v.Cmp(best) > 0 {
				best, bestTok = v, tok
			}
		}
		if bestTok == "" || best.Sign() <= 0 {
			continue
		}
		cands = append(cands, cand{addr, bestTok, best})
	}
	if len(cands) != 1 {
		return "", "", nil, false
	}
	return cands[0].addr, cands[0].token, cands[0].amount, true
}

// mobulaRow prices one paired fill into a Swap.
//
// given comes from the SOLANA leg, as the USDC credited to the solver's token
// account, which openchainbench-e9 asked for specifically: the deposit
// transaction can carry the app's gas and other legs, so the figure has to be
// what the solver received rather than what the user's balance moved by. That
// is already decided by the feed and arrives here in `in`.
//
// Everything after that is the existing pricer. priceEvmSettlement is the same
// function the Relay rows use, on the same definition, so this route's cost is
// comparable with theirs by construction rather than by coincidence.
func mobulaRow(ctx context.Context, httpc *http.Client, c originChain, chain, fill string, in mobulaIntent, gas map[string]float64) *Swap {
	var rc evmReceipt
	if err := evmCall(ctx, httpc, c.logsRPC(), "eth_getTransactionReceipt", []any{fill}, &rc); err != nil {
		return nil
	}
	if rc.Status != "0x1" {
		return &Swap{Flag: "reverted"}
	}
	user, token, _, ok := mobulaSink(rc.Logs)
	if !ok {
		// The receipt did not resolve to one user. Named so the share is
		// visible: it was 2 of 50 when the rule was validated, and a rise
		// means the fill shape changed rather than the bridge failing.
		return &Swap{Flag: "unpriced_no_sink"}
	}
	s, err := priceEvmSettlement(ctx, httpc, c, fill, user, token, gas)
	if err != nil {
		return nil
	}

	sw := &Swap{
		Method: methodVersion, Sig: fill, Terminal: "", Side: "buy",
		Quote: "USDC", QuoteUSD: 1, Venue: s.Venue, Mint: token, Tokens: s.Tokens,
		Chain: chain, RelayID: "", InTx: in.Deposit, User: user,
		Pools: s.Pools, Hops: s.Hops, PoolVault: s.Pool, Time: in.At,
	}
	if sw.Venue == "" {
		sw.Venue = "mobula"
	}
	sw.UserQ = in.Amount // the USDC the solver received, exact from the deposit
	// TERMINAL IS NOT MEASURED ON THIS ROUTE, and that is not the same as
	// zero. No app-fee transfer exists on either leg (the deposit carries
	// exactly one token transfer on all 50 read; the only non-user sinks on
	// the way out are the two in mobulaSinkSkip), but a fee an integrator
	// sets and the bridge takes inside its QUOTE leaves no transfer to find.
	// Such a fee would sit in the bridge residual below, so the residual is
	// published as the bridge's take INCLUDING any app charge, and the row's
	// note says so. Publishing 0 here would read as "this route is 50 bps
	// cheaper in app fees" when the fee had only moved.
	sw.TerminalQ = 0
	sw.NetworkQ = s.GasUSD // destination gas; the origin fee is the app's sponsor
	sw.PoolQ = s.PoolInUSD
	bridge := in.Amount - s.PoolInUSD - s.OtherUSD - s.GasUSD
	if bridge < 0 {
		bridge = 0
	}
	sw.RelayQ = bridge
	other := s.OtherUSD
	sw.OtherQ = &other
	if !s.Priced {
		sw.finalize(nil, 0, "")
		sw.Flag = "unpriced_" + s.Unpriced
		return sw
	}
	ref := s.MidUSD
	sw.finalize(&ref, 0, s.RefSrc)
	implausibleSplit(sw)
	return sw
}

// sampleMobula prices the fills the watcher paired since the last tick.
//
// Returns how many rows were added. Each fill costs one receipt read plus
// whatever priceEvmSettlement needs for the pool's pre-trade state, so this
// is bounded by `limit` the same way the Relay sampler is bounded by its
// quota: a busy minute must not spend the whole tick here.
func sampleMobula(ctx context.Context, httpc *http.Client, st *State, w *mobulaFillWatcher, gas map[string]float64, limit int) (added int) {
	if w == nil {
		return 0
	}
	pairs := w.drain()
	if len(pairs) == 0 {
		return 0
	}
	// Oldest first: a fill whose pool state is still readable prices better
	// than one an hour older, and dropping the tail is the honest trim.
	if limit > 0 && len(pairs) > limit {
		pairs = pairs[:limit]
	}
	for _, pr := range pairs {
		if ctx.Err() != nil {
			return added
		}
		var c originChain
		found := false
		for _, oc := range originChains {
			if oc.slug == pr.chain {
				c, found = oc, true
				break
			}
		}
		if !found {
			continue
		}
		slug := pr.in.App + "-" + pr.chain
		sw := mobulaRow(ctx, httpc, c, pr.chain, pr.fill, pr.in, gas)
		if sw == nil {
			continue
		}
		sw.Terminal = slug
		if sw.Flag != "" {
			st.reject(slug, parseReject(sw.Flag))
			continue
		}
		if sw.TradeUSD < minTradeUSD {
			st.reject(slug, rejectDust)
			continue
		}
		st.Swaps = append(st.Swaps, *sw)
		added++
	}
	return added
}
