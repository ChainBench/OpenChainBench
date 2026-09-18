package main

import (
	"context"
	"math"
	"sync"
)

// Sandwich detection on the block of a sampled swap.
//
// A sandwich is a pair of transactions by the same signer around the
// user's, on the same pool: one before it in the block trading in the
// same direction (the front-run moves the price against the user), one
// after it trading back (the back-run takes the profit). Jito bundles
// land the three adjacent; the scan accepts any positions inside the
// block. Multi-block sandwiches are not looked for.
//
// Attacker profit = quote received on the back-run − quote paid on the
// front-run, reported in basis points of the victim's trade. The victim's
// extra cost is already inside loss_bps (the front-run is before us, so
// the arrival price includes it); this isolates how often it happens and
// what the attacker took.
type Sandwich struct {
	Attacker  string  `json:"attacker"`
	FrontSig  string  `json:"front_sig"`
	BackSig   string  `json:"back_sig"`
	ProfitQ   float64 `json:"profit_q"`   // quote units
	ProfitBps float64 `json:"profit_bps"` // of the victim's trade
}

type blockTx struct {
	parsedTx
	Signatures []string
}

// blockCache keeps the blocks read during one tick (several samples can
// share a slot).
type blockCache struct {
	mu sync.Mutex
	m  map[uint64][]blockTx
}

func (c *rpcClient) block(ctx context.Context, slot uint64, cache *blockCache) ([]blockTx, error) {
	cache.mu.Lock()
	if b, ok := cache.m[slot]; ok {
		cache.mu.Unlock()
		return b, nil
	}
	cache.mu.Unlock()
	var out struct {
		Transactions []struct {
			Transaction struct {
				Signatures []string `json:"signatures"`
				Message    struct {
					AccountKeys []struct {
						Pubkey string `json:"pubkey"`
						Signer bool   `json:"signer"`
					} `json:"accountKeys"`
					Instructions []struct {
						ProgramID string `json:"programId"`
					} `json:"instructions"`
				} `json:"message"`
			} `json:"transaction"`
			Meta struct {
				Err               interface{}    `json:"err"`
				Fee               uint64         `json:"fee"`
				PreBalances       []uint64       `json:"preBalances"`
				PostBalances      []uint64       `json:"postBalances"`
				PreTokenBalances  []tokenBalance `json:"preTokenBalances"`
				PostTokenBalances []tokenBalance `json:"postTokenBalances"`
			} `json:"meta"`
		} `json:"transactions"`
	}
	err := c.call(ctx, "getBlock", []any{slot, map[string]any{
		"encoding": "jsonParsed", "transactionDetails": "full", "maxSupportedTransactionVersion": 1, "rewards": false, "commitment": "confirmed",
	}}, &out)
	if err != nil {
		return nil, err
	}
	txs := make([]blockTx, 0, len(out.Transactions))
	for _, t := range out.Transactions {
		var p parsedTx
		p.Slot = slot
		p.Transaction.Message.AccountKeys = t.Transaction.Message.AccountKeys
		p.Transaction.Message.Instructions = t.Transaction.Message.Instructions
		p.Meta.Fee = t.Meta.Fee
		p.Meta.PreBalances = t.Meta.PreBalances
		p.Meta.PostBalances = t.Meta.PostBalances
		p.Meta.PreTokenBalances = t.Meta.PreTokenBalances
		p.Meta.PostTokenBalances = t.Meta.PostTokenBalances
		if t.Meta.Err != nil {
			p.Meta.Err = []byte("1")
		}
		txs = append(txs, blockTx{parsedTx: p, Signatures: t.Transaction.Signatures})
	}
	cache.mu.Lock()
	cache.m[slot] = txs
	cache.mu.Unlock()
	return txs, nil
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

// detectSandwich scans the swap's block. ok is false when the block could
// not be read or the swap was not found in it.
func detectSandwich(ctx context.Context, rpc *rpcClient, sw *Swap, cache *blockCache, solUSD float64) (*Sandwich, bool) {
	if sw.PoolOwner == "" || sw.Slot == 0 {
		return nil, false
	}
	txs, err := rpc.block(ctx, sw.Slot, cache)
	if err != nil {
		return nil, false
	}
	mine := -1
	for i, t := range txs {
		if len(t.Signatures) > 0 && t.Signatures[0] == sw.Sig {
			mine = i
			break
		}
	}
	if mine < 0 {
		return nil, false
	}
	// The user's direction on the pool: buy = pool token balance falls.
	myTok := 1.0
	if sw.Side == "buy" {
		myTok = -1
	}
	type leg struct {
		idx    int
		signer string
		dTok   float64
		dQuote float64
	}
	var legs []leg
	for i, t := range txs {
		if i == mine || len(t.Meta.Err) > 0 || len(t.Transaction.Message.AccountKeys) == 0 {
			continue
		}
		dTok, dQuote := poolLeg(&t.parsedTx, sw, solUSD)
		if dTok == 0 || dQuote == 0 {
			continue
		}
		legs = append(legs, leg{idx: i, signer: t.Transaction.Message.AccountKeys[0].Pubkey, dTok: dTok, dQuote: dQuote})
	}
	sw.BlockPoolTxs = len(legs)
	// Front-run: before us, same direction; back-run: after us, opposite,
	// same signer. Take the pair closest to us.
	var best *Sandwich
	for _, f := range legs {
		if f.idx > mine || (f.dTok < 0) != (myTok < 0) {
			continue
		}
		for _, b := range legs {
			if b.idx < mine || b.signer != f.signer || (b.dTok < 0) == (f.dTok < 0) {
				continue
			}
			// Attacker paid |f.dQuote| (pool received it) on the front-run and
			// received |b.dQuote| (pool paid it) on the back-run.
			profit := math.Abs(b.dQuote) - math.Abs(f.dQuote)
			if sw.Side == "sell" {
				profit = math.Abs(f.dQuote) - math.Abs(b.dQuote) // front-run sold, back-run bought back
			}
			trade := sw.TradeUSD / sw.QuoteUSD
			s := &Sandwich{Attacker: f.signer, FrontSig: first(txs[f.idx].Signatures), BackSig: first(txs[b.idx].Signatures), ProfitQ: profit}
			if trade > 0 {
				s.ProfitBps = 1e4 * profit / trade
			}
			if best == nil || (b.idx-f.idx) < 0 {
				best = s
			}
			break
		}
		if best != nil {
			break
		}
	}
	return best, true
}

func first(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[0]
}
