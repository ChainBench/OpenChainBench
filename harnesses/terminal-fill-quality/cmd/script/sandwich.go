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
// vault's own signature sequence, which the arrival-price lookup already
// reads. So the screen costs nothing extra in the common case: the
// previous trade is read anyway for the reference price, the next one is
// read only when both neighbours sit in the user's slot (Jito bundles) or
// the very next one.
//
// Attacker profit = quote received on the back-run − quote paid on the
// front-run, in basis points of the victim's trade. The victim's extra
// cost is already inside loss_bps (the front-run precedes us, so the
// arrival price includes it); this isolates how often it happens.
type Sandwich struct {
	Attacker  string  `json:"attacker"`
	FrontSig  string  `json:"front_sig"`
	BackSig   string  `json:"back_sig"`
	ProfitQ   float64 `json:"profit_q"`   // quote units
	ProfitBps float64 `json:"profit_bps"` // of the victim's trade
}

// poolLeg returns the pool's token and quote movement in a transaction
// (quote in the swap's quote unit), zero when the pool is not traded.
func poolLeg(tx *parsedTx, sw *Swap, solUSD float64) (dTok, dQuote float64) {
	toQuote := func(asset string, amount float64) float64 {
		switch {
		case asset == sw.Quote:
			return amount
		case asset == "SOL":
			return amount * solUSD / sw.QuoteUSD
		default:
			return amount / sw.QuoteUSD
		}
	}
	pre := map[int]tokenBalance{}
	for _, b := range tx.Meta.PreTokenBalances {
		pre[b.AccountIndex] = b
	}
	for _, b := range tx.Meta.PostTokenBalances {
		if b.Owner != sw.PoolOwner {
			continue
		}
		p := pre[b.AccountIndex]
		d := (b.raw() - p.raw()) * math.Pow10(-b.UITokenAmount.Decimals)
		if math.IsNaN(d) {
			continue
		}
		switch {
		case b.Mint == sw.Mint:
			dTok += d
		case b.Mint == wsolMint:
			dQuote += toQuote("SOL", d)
		case stableMints[b.Mint]:
			dQuote += toQuote(quoteName(b.Mint), d)
		case sw.XMint != "" && b.Mint == sw.XMint:
			dQuote += d * sw.XRate
		}
	}
	if sw.Venue == "pump-curve" {
		keys := tx.Transaction.Message.AccountKeys
		for i, k := range keys {
			if k.Pubkey == sw.PoolOwner && i < len(tx.Meta.PreBalances) && i < len(tx.Meta.PostBalances) {
				dQuote += toQuote("SOL", float64(int64(tx.Meta.PostBalances[i])-int64(tx.Meta.PreBalances[i]))/1e9)
			}
		}
	}
	return dTok, dQuote
}

// neighbours is what the pool vault's signature list says about the
// swap: the previous successful transactions on the pool (newest first)
// and the next one after ours, when the list reaches it.
type neighbours struct {
	prev  []sigInfo // up to 3 before ours, newest first
	next  *sigInfo  // the first after ours, nil when unknown
	known bool      // ours was found in the list, so next is authoritative
}

// poolNeighbours reads the pool vault's newest signatures and locates the
// swap. When the swap is older than the page (a very busy pool), it falls
// back to a `before` query for the previous trades only.
func poolNeighbours(ctx context.Context, rpc *rpcClient, sw *Swap) (neighbours, error) {
	var page []sigInfo
	if err := rpc.call(ctx, "getSignaturesForAddress", []any{sw.PoolVault, map[string]any{"limit": 60, "commitment": "confirmed"}}, &page); err != nil {
		return neighbours{}, err
	}
	for i, s := range page {
		if s.Signature != sw.Sig {
			continue
		}
		n := neighbours{known: true}
		for j := i + 1; j < len(page) && len(n.prev) < 3; j++ {
			if !page[j].failed() {
				n.prev = append(n.prev, page[j])
			}
		}
		for j := i - 1; j >= 0; j-- {
			if !page[j].failed() {
				s := page[j]
				n.next = &s
				break
			}
		}
		return n, nil
	}
	var older []sigInfo
	if err := rpc.call(ctx, "getSignaturesForAddress", []any{sw.PoolVault, map[string]any{"limit": 3, "before": sw.Sig, "commitment": "confirmed"}}, &older); err != nil {
		return neighbours{}, err
	}
	n := neighbours{}
	for _, s := range older {
		if !s.failed() {
			n.prev = append(n.prev, s)
		}
	}
	return n, nil
}

// screenSandwich decides from the neighbours and the already-read previous
// transaction whether the swap was sandwiched. prevTx is the transaction
// of n.prev[0] (nil when not read). ok is false when the screen could not
// run (ours not located in the vault's list, or a read failed).
func screenSandwich(ctx context.Context, rpc *rpcClient, sw *Swap, n neighbours, prevTx *parsedTx, solUSD float64) (*Sandwich, bool) {
	if !n.known {
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
	fTok, fQuote := poolLeg(prevTx, sw, solUSD)
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
	bTok, bQuote := poolLeg(backTx, sw, solUSD)
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
