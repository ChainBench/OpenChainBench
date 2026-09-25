package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"math"
	"math/big"
	"strings"
	"sync"

	"filippo.io/edwards25519"
)

// Exact pre-trade mids from the venue's own swap event, for the venues
// whose vault balances do not give a mid: Raydium Launchpad (LaunchLab)
// and Meteora DLMM. Both emit an Anchor event in the swap transaction
// that carries the pool's state before the trade; each is accepted only
// when it reconciles with the balance deltas of the same transaction, so
// a layout mistake can never price a swap.
//
//	Launchpad TradeEvent (log "Program data:"): virtual and real reserves
//	  before / after; the curve's base reserve is virtual_base − real_base
//	  (real_base counts tokens sold), the quote reserve virtual_quote +
//	  real_quote. Check: real_base_after − real_base_before = −Δ base vault.
//	Meteora DLMM Swap (emit_cpi: an inner instruction to the program whose
//	  data is the event-CPI discriminator + the event): start_bin_id; a bin
//	  is a constant price (1 + bin_step / 1e4)^bin_id in Y per X. Check:
//	  the event's token amount equals the base vault delta and the
//	  executed price sits within 30 % of the start-bin price (fee + bins
//	  crossed).
//
// Verified on live swaps on 2026-09-18: Launchpad deltas reconcile to the
// raw unit; DLMM executed / start-bin = 0.92 on a sell with a 4.9 %
// dynamic fee crossing one bin.

var (
	discLaunchTrade = anchorEventDisc("TradeEvent")
	discDlmmSwap    = anchorEventDisc("Swap")
	discCpmmSwap    = anchorEventDisc("SwapEvent")
	anchorEventCPI  = [8]byte{0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d}
)

const (
	launchpadProgram = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"
	dlmmProgram      = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
	dlmmActiveIDAt   = 76 // LbPair: i32 after parameters (32), v_parameters (32), bump (1), bin_step_seed (2), pair_type (1)
	dlmmBinStepAt    = 80 // u16
	dlmmMintXAt      = 88
	dlmmMintYAt      = 120
)

func anchorEventDisc(name string) [8]byte {
	h := sha256.Sum256([]byte("event:" + name))
	var d [8]byte
	copy(d[:], h[:8])
	return d
}

// vaultInfo: a pool vault's mint, decimals and raw delta in the transaction.
type vaultInfo struct {
	mint  string
	dec   int
	delta float64 // raw units, post − pre
	found bool
}

func vaultOf(tx *parsedTx, pubkey string) vaultInfo {
	idx := -1
	for i, k := range tx.Transaction.Message.AccountKeys {
		if k.Pubkey == pubkey {
			idx = i
			break
		}
	}
	if idx < 0 {
		return vaultInfo{}
	}
	v := vaultInfo{}
	var pre, post float64
	for _, b := range tx.Meta.PreTokenBalances {
		if b.AccountIndex == idx {
			pre = b.raw()
			v.mint, v.dec, v.found = b.Mint, b.UITokenAmount.Decimals, true
		}
	}
	for _, b := range tx.Meta.PostTokenBalances {
		if b.AccountIndex == idx {
			post = b.raw()
			v.mint, v.dec, v.found = b.Mint, b.UITokenAmount.Decimals, true
		}
	}
	if math.IsNaN(pre) || math.IsNaN(post) {
		return vaultInfo{}
	}
	v.delta = post - pre
	return v
}

// toSwapQuote converts a price expressed in units of `mint` per token
// into the swap's quote unit per token.
func toSwapQuote(sw *Swap, mint string, price, solUSD float64) (float64, bool) {
	switch {
	case mint == wsolMint:
		if sw.Quote == "SOL" {
			return price, true
		}
		return price * solUSD / sw.QuoteUSD, true
	case stableMints[mint]:
		if sw.Quote == quoteName(mint) {
			return price, true
		}
		return price / sw.QuoteUSD, true
	case sw.XMint != "" && mint == sw.XMint && sw.XRate > 0:
		return price * sw.XRate, true
	}
	return 0, false
}

// eventMid returns the exact pre-trade mid of the swap's final pool from
// the venue's swap event, in the swap's quote unit per token.
func eventMid(ctx context.Context, rpc *rpcClient, sw *Swap, tx *parsedTx, solUSD float64) (float64, bool) {
	base := vaultOf(tx, sw.PoolVault)
	if !base.found || base.delta == 0 || base.mint != sw.Mint {
		return 0, false
	}
	switch sw.Venue {
	case "raydium-launchpad":
		return launchpadMid(sw, tx, base, solUSD)
	case "meteora-dlmm":
		return dlmmMid(ctx, rpc, sw, tx, base, solUSD)
	case "pump-curve":
		return pumpCurveMid(sw, tx, base, solUSD)
	case "raydium-cpmm":
		return cpmmMid(sw, tx, base, solUSD)
	}
	return 0, false
}

// pumpCurveMid: the pump.fun curve's mid before the trade from its own
// TradeEvent (log "Program data:"), which carries the virtual reserves
// after the trade; x·y = k gives the state before it. The curve's
// virtual reserves are not constants (on 2026-09-21 a curve went from
// 30.3 to 16.9 virtual SOL between two trades eight seconds apart: the
// previous-trade reference then read 80 % above the mid and printed a
// 4,434 bps impact on a sell that executed 33 bps under the mid), so the
// event of the transaction itself is the only reference that holds.
//
//	TradeEvent: mint(32) sol_amount(u64) token_amount(u64) is_buy(u8)
//	  user(32) timestamp(i64) virtual_sol(u64) virtual_token(u64)
//	  real_sol(u64) real_token(u64) …
//
// Accepted only when the event's token amount is the vault's own delta.
func pumpCurveMid(sw *Swap, tx *parsedTx, base vaultInfo, solUSD float64) (float64, bool) {
	for _, l := range tx.Meta.LogMessages {
		if !strings.HasPrefix(l, "Program data: ") {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(l[len("Program data: "):])
		if err != nil || len(raw) < 8+32+8+8+1+32+8+32 || [8]byte(raw[:8]) != discLaunchTrade {
			continue
		}
		o := 8 + 32
		solAmount := float64(binary.LittleEndian.Uint64(raw[o:]))
		tokAmount := float64(binary.LittleEndian.Uint64(raw[o+8:]))
		isBuy := raw[o+16] != 0
		o += 8 + 8 + 1 + 32 + 8
		vSol := float64(binary.LittleEndian.Uint64(raw[o:]))
		vTok := float64(binary.LittleEndian.Uint64(raw[o+8:]))
		// Ours when the token amount is the vault's movement (a buy pays the
		// vault out, a sale fills it).
		if math.Abs(math.Abs(base.delta)-tokAmount) > 1 || tokAmount <= 0 {
			continue
		}
		var solPre, tokPre float64
		if isBuy {
			solPre, tokPre = vSol-solAmount, vTok+tokAmount
		} else {
			solPre, tokPre = vSol+solAmount, vTok-tokAmount
		}
		if solPre <= 0 || tokPre <= 0 {
			return 0, false
		}
		mid := solPre / 1e9 / (tokPre * math.Pow10(-base.dec)) // SOL per token
		return toSwapQuote(sw, wsolMint, mid, solUSD)
	}
	return 0, false
}

func launchpadMid(sw *Swap, tx *parsedTx, base vaultInfo, solUSD float64) (float64, bool) {
	if len(sw.PoolQuoteVaults) != 1 {
		return 0, false
	}
	quote := vaultOf(tx, sw.PoolQuoteVaults[0])
	if !quote.found {
		return 0, false
	}
	for _, l := range tx.Meta.LogMessages {
		if !strings.HasPrefix(l, "Program data: ") {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(l[len("Program data: "):])
		if err != nil || len(raw) < 8+32+13*8 || [8]byte(raw[:8]) != discLaunchTrade {
			continue
		}
		body := raw[8+32:]
		u := func(i int) float64 { return float64(binary.LittleEndian.Uint64(body[8*i:])) }
		virtualBase, virtualQuote := u(1), u(2)
		realBaseBefore, realQuoteBefore := u(3), u(4)
		realBaseAfter := u(5)
		// The event belongs to our pool when its base movement is the vault's.
		if math.Abs((realBaseAfter-realBaseBefore)+base.delta) > 1 {
			continue
		}
		den := virtualBase - realBaseBefore
		if den <= 0 {
			return 0, false
		}
		midRaw := (virtualQuote + realQuoteBefore) / den // quote raw per base raw
		mid := midRaw * math.Pow10(base.dec-quote.dec)   // quote units per token
		return toSwapQuote(sw, quote.mint, mid, solUSD)
	}
	return 0, false
}

// dlmmPair: the LbPair constants read once per pool.
type dlmmPair struct {
	binStep      int
	mintX, mintY string
}

var dlmmCache = struct {
	sync.Mutex
	m map[string]dlmmPair
}{m: map[string]dlmmPair{}}

func dlmmMid(ctx context.Context, rpc *rpcClient, sw *Swap, tx *parsedTx, base vaultInfo, solUSD float64) (float64, bool) {
	for _, in := range tx.Meta.InnerInstructions {
		for _, ix := range in.Instructions {
			if ix.ProgramID != dlmmProgram || ix.Data == "" {
				continue
			}
			raw, ok := base58Decode(ix.Data)
			if !ok || len(raw) < 16+129 || [8]byte(raw[:8]) != anchorEventCPI || [8]byte(raw[8:16]) != discDlmmSwap {
				continue
			}
			body := raw[16:]
			lbPair := base58Encode(body[:32])
			if lbPair != sw.PoolOwner {
				continue
			}
			startBin := int32(binary.LittleEndian.Uint32(body[64:]))
			amountIn := float64(binary.LittleEndian.Uint64(body[72:]))
			amountOut := float64(binary.LittleEndian.Uint64(body[80:]))
			swapForY := body[88] == 1
			pair, ok := dlmmPairOf(ctx, rpc, lbPair)
			if !ok {
				return 0, false
			}
			// Our token is X or Y; the other side is the quote vault's mint.
			var quoteMint string
			tokenIsX := false
			switch sw.Mint {
			case pair.mintX:
				tokenIsX, quoteMint = true, pair.mintY
			case pair.mintY:
				quoteMint = pair.mintX
			default:
				return 0, false
			}
			var quoteDec int
			found := false
			for _, b := range tx.Meta.PostTokenBalances {
				if b.Mint == quoteMint && b.Owner == lbPair {
					quoteDec, found = b.UITokenAmount.Decimals, true
				}
			}
			if !found {
				return 0, false
			}
			// The event's token amount must be the base vault's movement.
			tokenAmount := amountOut
			if (tokenIsX && swapForY) || (!tokenIsX && !swapForY) {
				tokenAmount = amountIn // the user sold our token
			}
			if math.Abs(tokenAmount-math.Abs(base.delta)) > 1 {
				continue
			}
			// Bin price, Y per X in ui units, then per our token.
			decX, decY := base.dec, quoteDec
			if !tokenIsX {
				decX, decY = quoteDec, base.dec
			}
			pYX := math.Pow(1+float64(pair.binStep)/1e4, float64(startBin)) * math.Pow10(decX-decY)
			mid := pYX
			if !tokenIsX {
				mid = 1 / pYX
			}
			// Executed price per our token, for the sanity band.
			var exec float64
			if tokenIsX {
				if swapForY {
					exec = (amountOut / math.Pow10(decY)) / (amountIn / math.Pow10(decX))
				} else {
					exec = (amountIn / math.Pow10(decY)) / (amountOut / math.Pow10(decX))
				}
			} else {
				if swapForY {
					exec = (amountIn / math.Pow10(decX)) / (amountOut / math.Pow10(decY))
				} else {
					exec = (amountOut / math.Pow10(decX)) / (amountIn / math.Pow10(decY))
				}
			}
			if mid <= 0 || exec <= 0 || exec/mid < 0.7 || exec/mid > 1.3 {
				return 0, false
			}
			return toSwapQuote(sw, quoteMint, mid, solUSD)
		}
	}
	return 0, false
}

func dlmmPairOf(ctx context.Context, rpc *rpcClient, lbPair string) (dlmmPair, bool) {
	dlmmCache.Lock()
	p, hit := dlmmCache.m[lbPair]
	dlmmCache.Unlock()
	if hit {
		return p, p.binStep > 0
	}
	acc, err := rpc.account(ctx, lbPair)
	if err != nil || acc == nil || len(acc.Data) < dlmmMintYAt+32 {
		return dlmmPair{}, false
	}
	p = dlmmPair{
		binStep: int(binary.LittleEndian.Uint16(acc.Data[dlmmBinStepAt:])),
		mintX:   base58Encode(acc.Data[dlmmMintXAt : dlmmMintXAt+32]),
		mintY:   base58Encode(acc.Data[dlmmMintYAt : dlmmMintYAt+32]),
	}
	dlmmCache.Lock()
	if len(dlmmCache.m) >= poolCacheMax {
		dlmmCache.m = map[string]dlmmPair{}
	}
	dlmmCache.m[lbPair] = p
	dlmmCache.Unlock()
	return p, p.binStep > 0
}

// ─── base58 and curve check ──────────────────────────────────────────

const b58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

var b58Index = func() [256]int8 {
	var t [256]int8
	for i := range t {
		t[i] = -1
	}
	for i, c := range b58Alphabet {
		t[c] = int8(i)
	}
	return t
}()

func base58Decode(s string) ([]byte, bool) {
	n := new(big.Int)
	b58 := big.NewInt(58)
	for _, c := range []byte(s) {
		v := b58Index[c]
		if v < 0 {
			return nil, false
		}
		n.Mul(n, b58)
		n.Add(n, big.NewInt(int64(v)))
	}
	zeros := 0
	for zeros < len(s) && s[zeros] == '1' {
		zeros++
	}
	out := n.Bytes()
	return append(make([]byte, zeros), out...), true
}

func base58Encode(b []byte) string {
	n := new(big.Int).SetBytes(b)
	b58 := big.NewInt(58)
	mod := new(big.Int)
	var out []byte
	for n.Sign() > 0 {
		n.DivMod(n, b58, mod)
		out = append(out, b58Alphabet[mod.Int64()])
	}
	for _, c := range b {
		if c != 0 {
			break
		}
		out = append(out, '1')
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

var curveCache = struct {
	sync.Mutex
	m map[string]bool
}{m: map[string]bool{}}

// onCurve: a wallet (ed25519 public key) rather than a program-derived
// address, which is off the curve by construction. Used to tell a user
// from a pool when nobody signed for the user (keeper-executed orders).
func onCurve(pubkey string) bool {
	curveCache.Lock()
	v, hit := curveCache.m[pubkey]
	curveCache.Unlock()
	if hit {
		return v
	}
	raw, ok := base58Decode(pubkey)
	if ok && len(raw) == 32 {
		_, err := new(edwards25519.Point).SetBytes(raw)
		v = err == nil
	}
	curveCache.Lock()
	if len(curveCache.m) >= poolCacheMax {
		curveCache.m = map[string]bool{}
	}
	curveCache.m[pubkey] = v
	curveCache.Unlock()
	return v
}

// cpmmMid: Raydium CP-Swap's mid before the trade, taken from the reserves
// the program itself reports rather than from the vault balances.
//
// The curve does not run on the vault balance. It runs on
// vault − protocol_fees − fund_fees − creator_fees, all of which sit inside
// the same token account until someone collects them. The creator fee alone
// reached 6.84 SOL of a 105.49 SOL vault on one pool in the window — a 1 %
// rate accruing entirely on the SOL side — so a mid taken from the raw
// balance read 6.5 % high, the buyer came out looking filled better than any
// constant product allows, and the excess landed on the pool residual. Six of
// the fifteen Raydium buys that carried reserves published a negative pool;
// no venue whose mid is corrected did.
//
// Reading the fee counters out of the pool account does not work: they are
// read at head, the trade happened earlier, and a collection in between
// empties them. The event is the trade's own record.
//
//	SwapEvent: pool_id(32) input_vault_before(u64) output_vault_before(u64)
//	  input_amount(u64) output_amount(u64) input_transfer_fee(u64)
//	  output_transfer_fee(u64) base_input(u8) …
//
// Later builds append the mints and the fee split; everything used here is
// inside the prefix both emit.
func cpmmMid(sw *Swap, tx *parsedTx, base vaultInfo, solUSD float64) (float64, bool) {
	if len(sw.PoolQuoteVaults) != 1 {
		return 0, false
	}
	quote := vaultOf(tx, sw.PoolQuoteVaults[0])
	if !quote.found {
		return 0, false
	}
	for _, l := range tx.Meta.LogMessages {
		if !strings.HasPrefix(l, "Program data: ") {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(l[len("Program data: "):])
		if err != nil || len(raw) < 8+32+4*8 || [8]byte(raw[:8]) != discCpmmSwap {
			continue
		}
		body := raw[8+32:]
		u := func(i int) float64 { return float64(binary.LittleEndian.Uint64(body[8*i:])) }
		inBefore, outBefore, inAmount, outAmount := u(0), u(1), u(2), u(3)
		// Ours when the event's token leg is this vault's own movement: a buy
		// pays the base vault out, a sale fills it.
		var quoteBefore, baseBefore float64
		switch {
		case math.Abs(outAmount+base.delta) <= 1:
			quoteBefore, baseBefore = inBefore, outBefore
		case math.Abs(inAmount-base.delta) <= 1:
			quoteBefore, baseBefore = outBefore, inBefore
		default:
			continue
		}
		if quoteBefore <= 0 || baseBefore <= 0 {
			return 0, false
		}
		mid := quoteBefore / baseBefore * math.Pow10(base.dec-quote.dec) // quote units per token
		return toSwapQuote(sw, quote.mint, mid, solUSD)
	}
	return 0, false
}
