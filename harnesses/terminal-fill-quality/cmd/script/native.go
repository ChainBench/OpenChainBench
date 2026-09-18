package main

import (
	"context"
	"log"
	"math"
	"math/big"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

// Native EVM terminals: GMGN and Axiom route their BNB and Robinhood
// Chain swaps through their own router contracts, which emit an event
// on every swap. Polling eth_getLogs on those routers gives every
// successful swap they routed (a failed transaction emits nothing, so
// the fail rate is not measured here); a random sample is read.
//
// Per sampled swap the receipt gives the tokens delivered or sold, the
// pool(s) and their state before the swap (evm.go), and the gas; the
// transaction gives what the user sent (native value, or an ERC20 the
// user transferred). The terminal's fee is an internal native transfer to
// its collector, invisible in logs: it is the residual of what the user
// gave minus what reached the pool and the gas (buy), or what the pool
// paid out minus what the user received and the gas (sell). On a native
// sell what the user received is the change of their native balance
// across the block, plus the gas they paid.
type evmTerminal struct {
	Slug      string
	Name      string
	Kind      string
	Chain     string
	Routers   []string
	Collector string
	Note      string
}

var evmTerminals = []evmTerminal{
	{Slug: "gmgn-bnb", Name: "GMGN · BNB", Kind: "app", Chain: "bnb", Routers: []string{"0x1de460f363af910f51726def188f9004276bf4bc"}, Collector: "0xb8159ba378904f803639d274cec79f788931c9c8"},
	// GMGN's Robinhood Chain router: the emitter of GMGN's swap-end event
	// (0x8619026a…) on that chain, 654 swaps in 300 blocks on 2026-09-18;
	// a second, older one still trades.
	{Slug: "gmgn-robinhood", Name: "GMGN · Robinhood Chain", Kind: "app", Chain: "robinhood", Routers: []string{"0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc", "0xe492912f37c2a4eca45d42dc67548f4c6cd7ce2b"}, Collector: "0xb8159ba378904f803639d274cec79f788931c9c8"},
	{Slug: "axiom-bnb", Name: "Axiom · BNB", Kind: "app", Chain: "bnb", Routers: []string{"0x05701dc0b8f6711f6de3b282f46b10c813afb02d", "0x9689992f5b5c09447f15906d8d11214944488341", "0x5da7dd96efa6127e68c8ab06f125124c3c05d18d", "0x325098a6291a412bba7a52531ef05ac5dd7d5d6e"}, Collector: "0xdec29d79e8cdf009d2fa33e0558cb5648481cac3"},
	{Slug: "axiom-robinhood", Name: "Axiom · Robinhood Chain", Kind: "app", Chain: "robinhood", Routers: []string{
		"0xcda14e87628317e4f90077750fbe9634b896a24f", "0x76a0e120631735845769e3de2606924af7716150", "0xc6cdc85a225236013ee9b3b47dd05c07aed1fabc", "0x105358a03c47706ad4697e227d5a8ddfacf85448",
		"0xe3dc74b2d5b83916a1682777f1de8b2155ddfc38", "0xd9fc1771672f08f3abce96d033cc21d1e5a3ac7f", "0x578980d6cac7ab262c40dfca650b1d2d259c1cca", "0x4a86009a36fcec5aa341ffceb3205a911fcf6f60",
		"0x9689992f5b5c09447f15906d8d11214944488341"}, Collector: "0x6fb4460e4bebf662fcd9bfa5ce6d6231732bb86c"},
}

const nativeNote = "Swaps routed through the terminal's own contracts on this chain, read from their events (successful swaps only: a failed transaction emits none, so no fail rate here). Value given = what the user sent plus gas; value received = the tokens at the pool's state before the swap (v2 reserves, v3 / v4 previous price). The terminal's fee is paid inside the router as a native transfer: it is the residual after the pool and the gas."

// nativeFeed polls the routers' logs per chain since the last block seen.
type nativeFeed struct {
	http   *http.Client
	cursor map[string]int64 // chain -> last block scanned
	box    map[string]*xinboxTx
	up     map[string]bool
}

type xinboxTx struct {
	seen      int
	reservoir []string
	total     int
}

func newNativeFeed(httpc *http.Client, cursor map[string]int64) *nativeFeed {
	if cursor == nil {
		cursor = map[string]int64{}
	}
	return &nativeFeed{http: httpc, cursor: cursor, box: map[string]*xinboxTx{}, up: map[string]bool{}}
}

// poll reads every router log since the cursor (at most 2,000 blocks a
// tick) and counts the distinct transactions per terminal.
func (f *nativeFeed) poll(ctx context.Context) {
	for _, c := range originChains {
		var routers []string
		byRouter := map[string]string{}
		for _, t := range evmTerminals {
			if t.Chain != c.slug {
				continue
			}
			for _, r := range t.Routers {
				routers = append(routers, r)
				byRouter[r] = t.Slug
			}
		}
		if len(routers) == 0 {
			continue
		}
		var headHex string
		if err := evmCall(ctx, f.http, c.rpc, "eth_blockNumber", []any{}, &headHex); err != nil {
			f.up[c.slug] = false
			continue
		}
		head := hexInt(headHex)
		from := f.cursor[c.slug] + 1
		if from == 1 || head-from > 2000 {
			from = head - 200 // first run, or too far behind: start from the recent past
		}
		if from > head {
			f.up[c.slug] = true
			continue
		}
		// Ranges of at most 400 blocks, a few per tick: a public RPC may
		// refuse or redirect a heavier query.
		var logs []evmLog
		failed := false
		for chunk := 0; chunk < 5 && from <= head; chunk++ {
			to := from + 399
			if to > head {
				to = head
			}
			var part []evmLog
			if err := evmCall(ctx, f.http, c.rpc, "eth_getLogs", []any{map[string]any{"fromBlock": "0x" + big.NewInt(from).Text(16), "toBlock": "0x" + big.NewInt(to).Text(16), "address": routers}}, &part); err != nil {
				log.Printf("[native] %s getLogs %d-%d: %v", c.slug, from, to, err)
				failed = true
				break
			}
			logs = append(logs, part...)
			f.cursor[c.slug] = to
			from = to + 1
		}
		f.up[c.slug] = !failed
		seen := map[string]bool{}
		for _, l := range logs {
			slug := byRouter[strings.ToLower(l.Address)]
			if slug == "" || seen[l.TxHash] {
				continue
			}
			seen[l.TxHash] = true
			b := f.box[slug]
			if b == nil {
				b = &xinboxTx{}
				f.box[slug] = b
			}
			b.seen++
			b.total++
			if len(b.reservoir) < reservoirSize {
				b.reservoir = append(b.reservoir, l.TxHash)
			} else if j := rand.Intn(b.total); j < reservoirSize {
				b.reservoir[j] = l.TxHash
			}
		}
	}
}

func (f *nativeFeed) drain(slug string) (seen int, sample []string, total int) {
	b := f.box[slug]
	if b == nil {
		return 0, nil, 0
	}
	seen, sample, total = b.seen, b.reservoir, b.total
	f.box[slug] = &xinboxTx{}
	return
}

// sampleNative draws the tick's quota per native EVM terminal and measures.
func sampleNative(ctx context.Context, httpc *http.Client, st *State, nf *nativeFeed, gas map[string]float64, quota map[string]float64, perTick float64) (added, seen int) {
	nf.poll(ctx)
	now := time.Now().Unix()
	for _, t := range evmTerminals {
		n0, sample, total := nf.drain(t.Slug)
		seen += n0
		st.record(t.Slug, now, n0, 0, 0, nil)
		if total == 0 {
			continue
		}
		quota[t.Slug] += perTick
		if cap := math.Max(3*perTick, 2); quota[t.Slug] > cap {
			quota[t.Slug] = cap
		}
		n := int(quota[t.Slug])
		if n > len(sample) {
			n = len(sample)
		}
		if n <= 0 {
			continue
		}
		quota[t.Slug] -= float64(n)
		rand.Shuffle(len(sample), func(i, j int) { sample[i], sample[j] = sample[j], sample[i] })
		for _, h := range sample[:n] {
			sw := nativeRow(ctx, httpc, t, h, gas, now)
			if sw == nil {
				st.reject(t.Slug, "unreadable")
				continue
			}
			if sw.Flag != "" && !sw.Priced && strings.HasPrefix(sw.Flag, "unpriced_") {
				st.reject(t.Slug, parseReject(sw.Flag))
				continue
			}
			if sw.TradeUSD < minTradeUSD {
				st.reject(t.Slug, rejectDust)
				continue
			}
			st.Swaps = append(st.Swaps, *sw)
			added++
		}
	}
	return added, seen
}

// nativeRow reads one routed swap on its chain.
func nativeRow(ctx context.Context, httpc *http.Client, t evmTerminal, hash string, gas map[string]float64, now int64) *Swap {
	c := chainByID(0)
	for i := range originChains {
		if originChains[i].slug == t.Chain {
			c = &originChains[i]
		}
	}
	if c == nil {
		return nil
	}
	var tx evmTx
	if err := evmCall(ctx, httpc, c.rpc, "eth_getTransactionByHash", []any{hash}, &tx); err != nil {
		return nil
	}
	var rc evmReceipt
	if err := evmCall(ctx, httpc, c.rpc, "eth_getTransactionReceipt", []any{hash}, &rc); err != nil {
		return nil
	}
	user := strings.ToLower(tx.From)
	gasPrice, gasOK := gas[c.gas]
	if c.gas == "" {
		gasPrice, gasOK = 1, true
	}
	if !gasOK {
		return &Swap{Flag: "unpriced_gas"}
	}
	gasUSD := float64(hexInt(rc.GasUsed)) * float64(hexInt(rc.EffectiveGasPrice)) / 1e18 * gasPrice
	// The token: the ERC20 that reached the user (buy) or left the user
	// (sell) and is not a quote asset; what the user gave or got in quote
	// assets is read from the same transfers or the native value.
	bought, sold := map[string]*big.Int{}, map[string]*big.Int{}
	quoteIn, quoteOut := 0.0, 0.0
	for _, l := range rc.Logs {
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer {
			continue
		}
		erc, from, to, amt := strings.ToLower(l.Address), topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
		if from != user && to != user {
			continue
		}
		m := erc20(ctx, httpc, *c, erc)
		if q, ok := quoteUSD(m.symbol, *c, gas); ok && m.ok {
			usd := f(amt) * math.Pow10(-m.dec) * q
			if from == user {
				quoteIn += usd
			} else {
				quoteOut += usd
			}
			continue
		}
		if to == user {
			if bought[erc] == nil {
				bought[erc] = new(big.Int)
			}
			bought[erc].Add(bought[erc], amt)
		} else {
			if sold[erc] == nil {
				sold[erc] = new(big.Int)
			}
			sold[erc].Add(sold[erc], amt)
		}
	}
	pick := func(m map[string]*big.Int) string {
		best, bestAmt := "", new(big.Int)
		for k, v := range m {
			if v.Cmp(bestAmt) > 0 {
				best, bestAmt = k, v
			}
		}
		return best
	}
	value := f(hexBig(tx.Value)) / 1e18 * gasPrice
	sw := &Swap{Method: methodVersion, Sig: hash, Terminal: t.Slug, Slot: uint64(hexInt(rc.BlockNumber)), Time: now, User: user, Quote: "USD", QuoteUSD: 1, Chain: t.Chain, Pools: 1}
	zero := 0.0
	sw.OtherQ = &zero
	sw.NetworkQ = gasUSD
	if token := pick(bought); token != "" && len(sold) == 0 {
		// Buy: given = native value or quote ERC20 from the user, plus gas.
		given := value + quoteIn
		if given <= 0 {
			return &Swap{Flag: "unpriced_no_quote_in"}
		}
		s, err := priceEvmSettlement(ctx, httpc, *c, hash, user, token, gas)
		if err != nil {
			return nil
		}
		sw.Side, sw.Mint, sw.Tokens, sw.Venue, sw.Pools, sw.Hops, sw.PoolVault = "buy", token, s.Tokens, s.Venue, s.Pools, s.Hops, s.Pool
		sw.UserQ = given + gasUSD
		sw.PoolQ = s.PoolInUSD
		fee := given - s.PoolInUSD
		if fee < 0 {
			fee = 0
		}
		sw.TerminalQ = fee
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
	if token := pick(sold); token != "" {
		s, err := priceEvmOriginSale(ctx, httpc, *c, hash, user, token, gas)
		if err != nil {
			return nil
		}
		// Received: quote ERC20 to the user, else the native balance change
		// across the block plus the gas paid.
		recv := quoteOut
		if recv == 0 {
			bn := hexInt(rc.BlockNumber)
			var b0, b1 string
			if evmCall(ctx, httpc, c.rpc, "eth_getBalance", []any{user, "0x" + big.NewInt(bn-1).Text(16)}, &b0) != nil || evmCall(ctx, httpc, c.rpc, "eth_getBalance", []any{user, "0x" + big.NewInt(bn).Text(16)}, &b1) != nil {
				return &Swap{Flag: "unpriced_balance"}
			}
			delta := new(big.Float).SetInt(new(big.Int).Sub(hexBig(b1), hexBig(b0)))
			d, _ := delta.Float64()
			recv = d/1e18*gasPrice + gasUSD + value*0 // the gas left the same balance
			if recv <= 0 {
				return &Swap{Flag: "unpriced_no_receive"}
			}
		}
		sw.Side, sw.Mint, sw.Tokens, sw.Venue, sw.Pools, sw.Hops, sw.PoolVault = "sell", token, s.Tokens, s.Venue, s.Pools, s.Hops, s.Pool
		sw.UserQ = recv
		sw.PoolQ = s.PoolInUSD
		fee := s.PoolInUSD - recv
		if fee < 0 {
			fee = 0
		}
		sw.TerminalQ = fee
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
	return &Swap{Flag: "unpriced_no_token_leg"}
}
