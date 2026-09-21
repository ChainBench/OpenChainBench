package main

import (
	"context"
	"math"
)

// Sandwich detection by pool neighbourhood.
//
// A sandwich is a pair of transactions by the same signer around the
// user's, on the same pool: one just before it trading in the same
// direction (the front-run moves the price against the user), one just
// after trading back (the back-run takes the profit). Because both must
// touch the pool, they are the user's immediate neighbours in the pool
// vault's own signature sequence. The previous trade is read anyway for
// the arrival price; the next one is read only when the previous one
// qualifies as a front-run (same slot, same direction, not the user).
//
// Attacker profit = quote received on the back-run − quote paid on the
// front-run, in basis points of the victim's trade. The victim's extra
// cost is already inside loss_bps (the front-run precedes us, so the
// arrival price includes it); this isolates how often it happens. Kept
// in the JSON per swap (attacker, both signatures) so every hit can be
// checked on an explorer; not published as a ranking column.
type Sandwich struct {
	Attacker  string  `json:"attacker"`
	FrontSig  string  `json:"front_sig"`
	BackSig   string  `json:"back_sig"`
	ProfitQ   float64 `json:"profit_q"`   // quote units
	ProfitBps float64 `json:"profit_bps"` // of the victim's trade
}

// neighbours is what the pool vault's signature list says about the
// swap: the previous successful transactions on the pool (newest first)
// and the next one after ours.
type neighbours struct {
	prev  []sigInfo // up to 3 before ours, newest first
	next  *sigInfo  // the first successful one after ours, nil when none yet
	known bool      // the list reached our signature, so next is authoritative
}

// poolNeighbours reads the pool vault's signatures on both sides of the
// swap: `before` ours for the previous trades, `until` ours for the ones
// after it (the page runs from the head down to our signature; when it
// fills up without reaching us, on a very busy pool, next is unknown).
func poolNeighbours(ctx context.Context, rpc *rpcClient, sw *Swap) (neighbours, error) {
	var older []sigInfo
	if err := rpc.call(ctx, "getSignaturesForAddress", []any{sw.PoolVault, map[string]any{"limit": 6, "before": sw.Sig, "commitment": "confirmed"}}, &older); err != nil {
		return neighbours{}, err
	}
	n := neighbours{}
	for _, s := range older {
		if !s.failed() {
			n.prev = append(n.prev, s)
		}
		if len(n.prev) == 3 {
			break
		}
	}
	for _, page := range []int{100, 1000} {
		var newer []sigInfo
		if err := rpc.call(ctx, "getSignaturesForAddress", []any{sw.PoolVault, map[string]any{"limit": page, "until": sw.Sig, "commitment": "confirmed"}}, &newer); err != nil {
			return n, nil
		}
		if len(newer) >= page {
			continue
		}
		n.known = true
		for i := len(newer) - 1; i >= 0; i-- {
			if !newer[i].failed() {
				s := newer[i]
				n.next = &s
				break
			}
		}
		break
	}
	return n, nil
}

// screenSandwich decides from the neighbours and the already-read previous
// transaction whether the swap was sandwiched. prevTx is the transaction
// of n.prev[0] (nil when not read). ok is false when the screen could not
// run (list did not reach our signature, the swap is too recent for a
// back-run to be visible, or a read failed).
func screenSandwich(ctx context.Context, rpc *rpcClient, sw *Swap, n neighbours, prevTx *parsedTx, solUSD float64, now int64) (*Sandwich, bool) {
	if !n.known {
		return nil, false
	}
	if n.next == nil && now-sw.Time < 5 {
		return nil, false
	}
	if len(n.prev) == 0 || n.next == nil || prevTx == nil {
		return nil, true
	}
	front := n.prev[0]
	// Front-run in our slot; back-run in our slot or the next one.
	if front.Slot != sw.Slot || n.next.Slot > sw.Slot+1 {
		return nil, true
	}
	if len(prevTx.Transaction.Message.AccountKeys) == 0 {
		return nil, true
	}
	fSigner := prevTx.Transaction.Message.AccountKeys[0].Pubkey
	if fSigner == sw.User {
		return nil, true // the user's own previous trade is not a front-run
	}
	fTok, fQuote := poolTradeLeg(prevTx, sw, solUSD)
	myTok := 1.0
	if sw.Side == "buy" {
		myTok = -1
	}
	if fTok == 0 || fQuote == 0 || (fTok < 0) != (myTok < 0) {
		return nil, true // previous trade is not in our direction
	}
	backTx, err := rpc.transaction(ctx, n.next.Signature)
	if err != nil || backTx == nil || len(backTx.Transaction.Message.AccountKeys) == 0 {
		return nil, false
	}
	if backTx.Transaction.Message.AccountKeys[0].Pubkey != fSigner {
		return nil, true
	}
	bTok, bQuote := poolTradeLeg(backTx, sw, solUSD)
	if bTok == 0 || bQuote == 0 || (bTok < 0) == (fTok < 0) {
		return nil, true
	}
	// The back-run closes the front-run: comparable token amounts and a
	// positive take.
	ratio := math.Abs(bTok) / math.Abs(fTok)
	if ratio < 0.5 || ratio > 2 {
		return nil, true
	}
	profit := math.Abs(bQuote) - math.Abs(fQuote)
	if sw.Side == "sell" {
		profit = math.Abs(fQuote) - math.Abs(bQuote)
	}
	if profit <= 0 {
		return nil, true
	}
	s := &Sandwich{Attacker: fSigner, FrontSig: front.Signature, BackSig: n.next.Signature, ProfitQ: profit}
	if trade := sw.TradeUSD / sw.QuoteUSD; trade > 0 {
		s.ProfitBps = 1e4 * profit / trade
	}
	return s, true
}
