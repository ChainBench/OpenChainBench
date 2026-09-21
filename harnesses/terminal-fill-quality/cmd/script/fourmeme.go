package main

import (
	"context"
	"math"
	"math/big"
	"net/http"
	"strings"
	"sync"
)

// four.meme, BNB's launchpad: tokens trade on a bonding curve held by its
// TokenManager (V2 0x5c952063…, V1 0xEC4549ca…) until they migrate to a
// pool. Every trade emits TokenPurchase / TokenSale(token, account,
// price, amount, cost, fee, offers, funds): amount = tokens, cost = quote
// paid in (buy: the user pays cost + fee) or paid out (sell: the user
// gets cost − fee), fee = the protocol's 1 % (`other`, like pump.fun's
// fee on Solana), offers / funds = tokens left on the curve and quote
// raised after the trade.
//
// The curve is a constant product on virtual reserves: checked on
// consecutive events of one token (2026-09-19), (offers + vt) × (vq +
// funds) holds to 1e-12 across trades. `_tokenInfos(token)` on the
// manager gives K = x × y / 1e18 (word 10) and T = offers + vt (word 11)
// next to the current offers (word 7) and the quote token (word 1, USDT
// on most curves, zero = BNB), so vt = T − offers and the mid before our
// trade is K × 1e18 / x_before² with x_before = offers_after ± amount +
// vt, exact.
const (
	topicFourPurchase = "0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942"
	topicFourSale     = "0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19"
)

var fourMemeManagers = map[string]bool{
	"0x5c952063c7fc8610ffdb798152d69f0b9550762b": true,
	"0xec4549cadce5da21df6e6422d448034b5233bfbc": true,
}

type fourInfo struct {
	quote string // quote token, "" for the gas coin
	k     *big.Int
	vt    *big.Int
	ok    bool
}

var fourCache = struct {
	sync.Mutex
	m map[string]fourInfo
}{m: map[string]fourInfo{}}

// fourTokenInfo reads the curve's constants once per token.
func fourTokenInfo(ctx context.Context, httpc *http.Client, c originChain, manager, token string) fourInfo {
	key := manager + ":" + token
	fourCache.Lock()
	info, hit := fourCache.m[key]
	fourCache.Unlock()
	if hit {
		return info
	}
	var res string
	if err := evmCall(ctx, httpc, c.rpc, "eth_call", []any{map[string]any{"to": manager, "data": "0xe684626b" + strings.Repeat("0", 24) + strings.TrimPrefix(token, "0x")}, "latest"}, &res); err == nil && len(res) >= 2+64*12 {
		quote := "0x" + strings.ToLower(res[2+64*1+24:2+64*2])
		if quote == "0x0000000000000000000000000000000000000000" {
			quote = ""
		}
		offers, k, t := word(res, 7), word(res, 10), word(res, 11)
		if k.Sign() > 0 && t.Cmp(offers) > 0 {
			info = fourInfo{quote: quote, k: k, vt: new(big.Int).Sub(t, offers), ok: true}
		}
	}
	fourCache.Lock()
	if len(fourCache.m) >= poolCacheMax {
		fourCache.m = map[string]fourInfo{}
	}
	if info.ok {
		fourCache.m[key] = info
	}
	fourCache.Unlock()
	return info
}

type fourTrade struct {
	manager                          string
	buy                              bool
	price, amount, cost, fee, offers *big.Int
	index                            int64
}

// fourTrades lists the curve trades of the token in the receipt.
func fourTrades(logs []evmLog, token string) []fourTrade {
	var out []fourTrade
	for i := range logs {
		l := &logs[i]
		if len(l.Topics) != 1 || !fourMemeManagers[strings.ToLower(l.Address)] || (l.Topics[0] != topicFourPurchase && l.Topics[0] != topicFourSale) {
			continue
		}
		if "0x"+strings.ToLower(strings.TrimPrefix(l.Data, "0x")[24:64]) != token {
			continue
		}
		out = append(out, fourTrade{manager: strings.ToLower(l.Address), buy: l.Topics[0] == topicFourPurchase, price: word(l.Data, 2), amount: word(l.Data, 3), cost: word(l.Data, 4), fee: word(l.Data, 5), offers: word(l.Data, 6), index: hexInt(l.LogIndex)})
	}
	return out
}

// priceFourMeme fills the settlement from a curve trade: the quote the
// curve took or paid (pool), the protocol fee (other), the mid before.
func priceFourMeme(ctx context.Context, httpc *http.Client, c originChain, out *evmSettlement, tr fourTrade, token string, tokenDec int, gas map[string]float64) {
	// The event's own consistency check (price × amount = cost, to 1 %)
	// guards the layout: the V1 manager is assumed to share V2's, and a
	// different one could not pass it.
	if tr.amount.Sign() <= 0 || tr.cost.Sign() <= 0 || math.Abs(f(tr.price)*f(tr.amount)/1e18/f(tr.cost)-1) > 0.01 {
		out.Unpriced = "four_meme_layout"
		return
	}
	info := fourTokenInfo(ctx, httpc, c, tr.manager, token)
	if !info.ok {
		out.Unpriced = "four_meme_info"
		return
	}
	q, qdec := 0.0, 18
	if info.quote == "" {
		p, ok := gas[c.gas]
		if !ok || p <= 0 {
			out.Unpriced = "gas_price"
			return
		}
		q = p
	} else {
		m := erc20(ctx, httpc, c, info.quote)
		p, ok := quoteUSD(m.symbol, c, gas)
		if !m.ok || !ok {
			out.Unpriced = "quote_" + m.symbol
			return
		}
		q, qdec = p, m.dec
	}
	unit := math.Pow10(-qdec) * q
	out.Venue, out.Pool, out.Pools = "four-meme", tr.manager, 1
	out.PoolInUSD = f(tr.cost) * unit
	out.OtherUSD = f(tr.fee) * unit
	out.Tokens = f(tr.amount) * math.Pow10(-tokenDec)
	x := new(big.Int).Add(tr.offers, info.vt)
	if tr.buy {
		x.Add(x, tr.amount)
	} else {
		x.Sub(x, tr.amount)
	}
	if x.Sign() <= 0 {
		out.Unpriced = "four_meme_reserves"
		return
	}
	midRaw := f(info.k) * 1e18 / (f(x) * f(x)) // raw quote per raw token
	out.MidUSD = midRaw * math.Pow10(tokenDec-qdec) * q
	out.RefSrc = "reserves"
	out.Priced = out.MidUSD > 0
	if !out.Priced {
		out.Unpriced = "no_mid"
	}
}
