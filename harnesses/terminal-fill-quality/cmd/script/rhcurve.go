package main

// Bonding-curve trades of the launchpad the BasedBot router family trades
// on (Robinhood Chain first: one curve contract per token, the same
// 10,230-byte bytecode on every one, no Uniswap event). The curve emits
// one event per trade, indexed (sender, recipient):
//
//	buy  0xec36bf57…: data [gas coin in, tokens out, fee 1, fee 2]
//	sell 0x8113d738…: data [tokens in, gas coin out, fee 1, fee 2]
//
// The fees (1 % + 2 % on 2026-09-21) are taken on the gross amount: on a
// buy the reserve gets the input less the fees, on a sell the reserve
// gives the output plus the fees. The curve's formula is not read: the
// reference is the previous trade on the same curve, as for pump.fun's
// curve on Solana, at the reserve-side price (net input, or gross output,
// per token). 15 of 40 router swaps on Robinhood Chain on 2026-09-21 were
// curve trades, all unpriced before this.

import (
	"context"
	"log"
	"math"
	"math/big"
	"net/http"
	"sort"
	"strings"
)

const (
	topicRHCurveBuy  = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455"
	topicRHCurveSell = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df"
)

type rhTrade struct {
	curve                     string
	buy                       bool
	quote, tokens, fee1, fee2 *big.Int // raw
	block, index              int64
}

func rhTradeOf(l *evmLog) (rhTrade, bool) {
	if len(l.Topics) != 3 || (l.Topics[0] != topicRHCurveBuy && l.Topics[0] != topicRHCurveSell) || len(strings.TrimPrefix(l.Data, "0x")) < 64*4 {
		return rhTrade{}, false
	}
	t := rhTrade{curve: strings.ToLower(l.Address), buy: l.Topics[0] == topicRHCurveBuy, fee1: word(l.Data, 2), fee2: word(l.Data, 3), block: hexInt(l.BlockNumber), index: hexInt(l.LogIndex)}
	if t.buy {
		t.quote, t.tokens = word(l.Data, 0), word(l.Data, 1)
	} else {
		t.tokens, t.quote = word(l.Data, 0), word(l.Data, 1)
	}
	return t, true
}

// rhTrades: the curve trades in a receipt whose curve moved the token
// (paid it out on a buy, took it in on a sale).
func rhTrades(logs []evmLog, buy bool, moved map[string]*big.Int) []rhTrade {
	var out []rhTrade
	for i := range logs {
		t, ok := rhTradeOf(&logs[i])
		if !ok || t.buy != buy || moved[t.curve] == nil || moved[t.curve].Sign() == 0 || t.tokens.Sign() <= 0 || t.quote.Sign() <= 0 {
			continue
		}
		out = append(out, t)
	}
	return out
}

// reservePrice: raw gas coin per raw token at the reserve's side of the
// trade (input net of the fees on a buy, output plus the fees on a sale).
func (t rhTrade) reservePrice() float64 {
	q := new(big.Int).Set(t.quote)
	if t.buy {
		q.Sub(q, t.fee1)
		q.Sub(q, t.fee2)
	} else {
		q.Add(q, t.fee1)
		q.Add(q, t.fee2)
	}
	if q.Sign() <= 0 {
		return 0
	}
	return f(q) / f(t.tokens)
}

// priceRHCurve fills the settlement from a curve trade: pool = the
// reserve's side of the trade, other = the launchpad's fees, the mid = the
// previous trade on the same curve.
func priceRHCurve(ctx context.Context, httpc *http.Client, c originChain, out *evmSettlement, tr rhTrade, token string, tokenDec int, gas map[string]float64, logs []evmLog) {
	// The curve's quote: the gas coin itself when no ERC20 moved the
	// amount to or from the curve, else that ERC20 (a stable, the wrapped
	// gas coin, or a token the route bought on the way: priced through
	// the swap that paid it out).
	unit, qdec, ok := curveQuoteUnit(ctx, httpc, c, tr, token, gas, logs)
	if !ok {
		out.Unpriced = "curve_quote"
		return
	}
	p := unit * math.Pow10(qdec) // USD per whole quote unit
	fees := new(big.Int).Add(tr.fee1, tr.fee2)
	out.Venue, out.Pool, out.Pools = "launchpad-curve", tr.curve, 1
	out.OtherUSD = f(fees) * unit
	out.PoolInUSD = tr.reservePrice() * f(tr.tokens) * unit
	out.Tokens = f(tr.tokens) * math.Pow10(-tokenDec)
	// The previous trade on the curve: Robinhood Chain makes ~590 blocks
	// a minute and the keyed node caps eth_getLogs at 10,000 blocks, so
	// the walk goes back in 9,000-block chunks (about 15 min each) up to
	// eight of them (two hours); a curve quiet for longer stays unpriced.
	var prev *rhTrade
	to := tr.block
	for chunk := 0; chunk < 8 && prev == nil && to > 0; chunk++ {
		from := to - 9000
		if from < 0 {
			from = 0
		}
		var logs []evmLog
		if err := evmCall(ctx, httpc, c.logsRPC(), "eth_getLogs", []any{map[string]any{"address": tr.curve, "topics": []any{[]string{topicRHCurveBuy, topicRHCurveSell}}, "fromBlock": "0x" + big.NewInt(from).Text(16), "toBlock": "0x" + big.NewInt(to).Text(16)}}, &logs); err != nil && !strings.Contains(err.Error(), "empty result") {
			out.Unpriced = "curve_logs"
			log.Printf("[evm] curve %s previous trades: %s", tr.curve, redactURL(err.Error(), c.logsRPC()[0]))
			return
		}
		sort.Slice(logs, func(i, j int) bool {
			bi, bj := hexInt(logs[i].BlockNumber), hexInt(logs[j].BlockNumber)
			if bi != bj {
				return bi < bj
			}
			return hexInt(logs[i].LogIndex) < hexInt(logs[j].LogIndex)
		})
		for i := range logs {
			t, ok := rhTradeOf(&logs[i])
			if !ok || t.tokens.Sign() <= 0 || t.quote.Sign() <= 0 {
				continue
			}
			if t.block < tr.block || (t.block == tr.block && t.index < tr.index) {
				tt := t
				prev = &tt
			}
		}
		to = from - 1
	}
	if prev == nil {
		// The launch itself (the token minted to the curve in this
		// transaction, the creator's first buy): no reference, and not a
		// user's fill; else a curve quiet for two hours.
		out.Unpriced = "curve_no_prev"
		for i := range logs {
			l := &logs[i]
			if len(l.Topics) == 3 && l.Topics[0] == topicTransfer && strings.ToLower(l.Address) == token && topicAddr(l.Topics[1]) == "0x0000000000000000000000000000000000000000" && topicAddr(l.Topics[2]) == tr.curve {
				out.Unpriced = "launch"
			}
		}
		return
	}
	mid := prev.reservePrice() // raw gas coin per raw token
	if mid <= 0 {
		out.Unpriced = "no_mid"
		return
	}
	out.MidUSD = mid * math.Pow10(tokenDec-qdec) * p
	out.RefSrc = "pool"
	out.Priced = out.MidUSD > 0
}

// curveQuoteUnit: USD per raw unit of the curve's quote and its decimals.
func curveQuoteUnit(ctx context.Context, httpc *http.Client, c originChain, tr rhTrade, token string, gas map[string]float64, logs []evmLog) (float64, int, bool) {
	close := func(a, b *big.Int) bool {
		d := new(big.Int).Sub(a, b)
		d.Abs(d)
		return d.Cmp(new(big.Int).Div(b, big.NewInt(200))) <= 0
	}
	// An ERC20 moving the quote amount into (buy) or out of (sell) the curve.
	quoteErc := ""
	for i := range logs {
		l := &logs[i]
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer || strings.ToLower(l.Address) == token {
			continue
		}
		from, to := topicAddr(l.Topics[1]), topicAddr(l.Topics[2])
		if ((tr.buy && to == tr.curve) || (!tr.buy && from == tr.curve)) && close(word(l.Data, 0), tr.quote) {
			quoteErc = strings.ToLower(l.Address)
			break
		}
	}
	if quoteErc == "" {
		p, ok := gas[c.gas]
		if c.gas == "" || !ok || p <= 0 {
			return 0, 0, false
		}
		return 1e-18 * p, 18, true
	}
	qm := erc20(ctx, httpc, c, quoteErc)
	if !qm.ok {
		return 0, 0, false
	}
	if q, ok := quoteUSD(qm.symbol, c, gas); ok {
		return q * math.Pow10(-qm.dec), qm.dec, true
	}
	// A token the route bought for the curve: the swap that paid it out,
	// against a priced ERC20 that went into that pool.
	for i := range logs {
		ev := parseSwapEv(&logs[i])
		if ev == nil {
			continue
		}
		for side := 0; side < 2; side++ {
			if ev.out[side].Sign() <= 0 || !close(ev.out[side], tr.quote) || ev.in[1-side].Sign() <= 0 {
				continue
			}
			for j := range logs {
				l := &logs[j]
				if len(l.Topics) != 3 || l.Topics[0] != topicTransfer || topicAddr(l.Topics[2]) != ev.pool || !close(word(l.Data, 0), ev.in[1-side]) {
					continue
				}
				im := erc20(ctx, httpc, c, strings.ToLower(l.Address))
				if q, ok := quoteUSD(im.symbol, c, gas); im.ok && ok {
					inUSD := f(ev.in[1-side]) * q * math.Pow10(-im.dec)
					return inUSD / f(ev.out[side]), qm.dec, true
				}
			}
		}
	}
	return 0, 0, false
}
