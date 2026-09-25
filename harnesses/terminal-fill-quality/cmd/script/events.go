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
	discPumpSwapBuy = anchorEventDisc("BuyEvent")
	discPumpSwapSel = anchorEventDisc("SellEvent")
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
	mint      string
	dec       int
	delta     float64 // raw units, post − pre
	pre, post float64 // raw units
	found     bool
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
	v.pre, v.post = pre, post
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
	case "pumpswap":
		return pumpSwapMid(ctx, rpc, sw, tx, base, solUSD)
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
		if tokPre <= 0 {
			return 0, false
		}
		if solAmount == 0 && vSol == 0 {
			// A curve quoted in a token (PUMP and the like): the SOL fields
			// read zero and the quote side closes the event, its last two
			// words virtual_quote_reserves_after and real_quote_reserves_after.
			// The quote vault's own post-balance names the second, which
			// places the first; the vault's delta is the quote moved. These
			// rows had fallen back to the previous trade, one second old
			// and on the wrong side of the mid by 94–96 bps.
			return pumpCurveTokenQuotedMid(sw, tx, raw, isBuy, tokPre, vTok, solUSD)
		}
		if solPre <= 0 {
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

// pumpCurveTokenQuotedMid: see pumpCurveMid. raw is the whole TradeEvent;
// tokPre the virtual token reserve before the trade, vTokAfter after it.
func pumpCurveTokenQuotedMid(sw *Swap, tx *parsedTx, raw []byte, isBuy bool, tokPre, vTokAfter, solUSD float64) (float64, bool) {
	if len(sw.PoolQuoteVaults) < 1 || len(raw) < 16 {
		return 0, false
	}
	qv := vaultOf(tx, sw.PoolQuoteVaults[0])
	if !qv.found || qv.delta == 0 {
		return 0, false
	}
	// The quote-side pair is not the last two words: the event carries
	// sixteen more bytes after real_quote_reserves_after (read off a LULU
	// curve: …, 65246777, 23653600, 30, 236, with 23653600 the vault's
	// post-balance). So find the vault's post-balance in the body and take
	// the word before it as the virtual quote reserve after the trade.
	post := uint64(qv.post)
	at := -1
	for i := len(raw) - 8; i >= 8+32+16; i -= 8 {
		if binary.LittleEndian.Uint64(raw[i:]) == post {
			at = i
			break
		}
	}
	if at < 0 {
		return 0, false // not this event's tail, or not this vault
	}
	vQuoteAfter := float64(binary.LittleEndian.Uint64(raw[at-8:]))
	moved := math.Abs(qv.delta)
	vQuotePre := vQuoteAfter - moved
	if !isBuy {
		vQuotePre = vQuoteAfter + moved
	}
	if vQuotePre <= 0 || vTokAfter <= 0 {
		return 0, false
	}
	// x·y = k across the trade, to a part in a hundred thousand.
	kPre, kAfter := vQuotePre*tokPre, vQuoteAfter*vTokAfter
	if kAfter <= 0 || math.Abs(kPre-kAfter)/kAfter > 1e-5 {
		return 0, false
	}
	base := vaultOf(tx, sw.PoolVault)
	if !base.found {
		return 0, false
	}
	mid := vQuotePre / tokPre * math.Pow10(base.dec-qv.dec) // quote units per token
	return toSwapQuote(sw, qv.mint, mid, solUSD)
}

const pumpSwapProgramID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"

// pumpSwapMid: a PumpSwap pool's mid before the trade from its own
// BuyEvent / SellEvent — pool_base_token_reserves and
// pool_quote_token_reserves are the pre-trade vaults — plus the pool
// account's virtual quote offset (byte 245), the same offset reservePrice
// applies on SOL-quoted pools. Used where reservePrice cannot run: a pool
// quoted in a third token carries no PoolQuotePre, so those rows had
// fallen back to the previous trade.
//
//	BuyEvent : timestamp(i64) base_amount_out max_quote_amount_in
//	  user_base_reserves user_quote_reserves pool_base_reserves
//	  pool_quote_reserves quote_amount_in … (u64 each), then pool(32)
//	SellEvent: the same shape with base_amount_in / min_quote_amount_out
func pumpSwapMid(ctx context.Context, rpc *rpcClient, sw *Swap, tx *parsedTx, base vaultInfo, solUSD float64) (float64, bool) {
	if len(sw.PoolQuoteVaults) < 1 || sw.PoolOwner == "" {
		return 0, false
	}
	poolRaw, ok := base58Decode(sw.PoolOwner)
	if !ok || len(poolRaw) != 32 {
		return 0, false
	}
	try := func(body []byte, disc [8]byte) (float64, bool) {
		if len(body) < 14*8+32 {
			return 0, false
		}
		if string(body[14*8:14*8+32]) != string(poolRaw) {
			return 0, false
		}
		u := func(i int) float64 { return float64(binary.LittleEndian.Uint64(body[8*i:])) }
		if math.Abs(u(1)-math.Abs(base.delta)) > 1 { // the base amount is this vault's movement
			return 0, false
		}
		baseRes, quoteRes := u(5), u(6)
		if baseRes <= 0 || quoteRes < 0 {
			return 0, false
		}
		acc, err := rpc.account(ctx, sw.PoolOwner)
		if err != nil || acc == nil || len(acc.Data) < pumpSwapQuoteOffsetAt+8 {
			return 0, false
		}
		offset := float64(binary.LittleEndian.Uint64(acc.Data[pumpSwapQuoteOffsetAt:]))
		qv := vaultOf(tx, sw.PoolQuoteVaults[0])
		if !qv.found {
			return 0, false
		}
		mid := (quoteRes + offset) / baseRes * math.Pow10(base.dec-qv.dec)
		return toSwapQuote(sw, qv.mint, mid, solUSD)
	}
	for _, l := range tx.Meta.LogMessages {
		if !strings.HasPrefix(l, "Program data: ") {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(l[len("Program data: "):])
		if err != nil || len(raw) < 8 {
			continue
		}
		d := [8]byte(raw[:8])
		if d != discPumpSwapBuy && d != discPumpSwapSel {
			continue
		}
		if mid, ok := try(raw[8:], d); ok {
			return mid, true
		}
	}
	for _, in := range tx.Meta.InnerInstructions {
		for _, ix := range in.Instructions {
			if ix.ProgramID != pumpSwapProgramID || ix.Data == "" {
				continue
			}
			raw, ok := base58Decode(ix.Data)
			if !ok || len(raw) < 16 || [8]byte(raw[:8]) != anchorEventCPI {
				continue
			}
			d := [8]byte(raw[8:16])
			if d != discPumpSwapBuy && d != discPumpSwapSel {
				continue
			}
			if mid, ok := try(raw[16:], d); ok {
				return mid, true
			}
		}
	}
	return 0, false
}
