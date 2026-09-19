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
	// A fixed inclusion tip the terminal adds to every transaction, in
	// gas coins, and the account it goes to (an internal transfer from the
	// router, checked through that account's balance across the block);
	// counted as network cost like the Solana terminals' own tip relays.
	Tip   float64
	TipTo string
	// NoEvents: the router emits nothing (Binance Wallet's), so its swaps
	// come from the block sample alone: every successful transaction
	// sent to it in the sampled blocks.
	NoEvents bool
	Note     string
}

var evmTerminals = []evmTerminal{
	{Slug: "gmgn-bnb", Name: "GMGN · BNB", Kind: "app", Chain: "bnb", Routers: []string{"0x1de460f363af910f51726def188f9004276bf4bc"}, Collector: "0xb8159ba378904f803639d274cec79f788931c9c8"},
	// GMGN's Robinhood Chain router: the emitter of GMGN's swap-end event
	// (0x8619026a…) on that chain, 654 swaps in 300 blocks on 2026-09-18;
	// a second, older one still trades.
	{Slug: "gmgn-robinhood", Name: "GMGN · Robinhood Chain", Kind: "app", Chain: "robinhood", Routers: []string{"0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc", "0xe492912f37c2a4eca45d42dc67548f4c6cd7ce2b"}, Collector: "0xb8159ba378904f803639d274cec79f788931c9c8"},
	{Slug: "axiom-bnb", Name: "Axiom · BNB", Kind: "app", Chain: "bnb", Routers: []string{"0x05701dc0b8f6711f6de3b282f46b10c813afb02d", "0x9689992f5b5c09447f15906d8d11214944488341", "0x5da7dd96efa6127e68c8ab06f125124c3c05d18d", "0x325098a6291a412bba7a52531ef05ac5dd7d5d6e"}, Collector: "0xdec29d79e8cdf009d2fa33e0558cb5648481cac3",
		// Every Axiom BNB transaction forwards a fixed 0.0025 BNB to this
		// account (call trace of 0x547a8838…, 0xc804c93e…, 2026-09-18) on
		// top of the 1 % to the collector.
		Tip: 0.0025, TipTo: "0xdd8431ce6a62698708292ec5508a3708a0bf1226"},
	{Slug: "axiom-robinhood", Name: "Axiom · Robinhood Chain", Kind: "app", Chain: "robinhood", Routers: []string{
		"0xcda14e87628317e4f90077750fbe9634b896a24f", "0x76a0e120631735845769e3de2606924af7716150", "0xc6cdc85a225236013ee9b3b47dd05c07aed1fabc", "0x105358a03c47706ad4697e227d5a8ddfacf85448",
		"0xe3dc74b2d5b83916a1682777f1de8b2155ddfc38", "0xd9fc1771672f08f3abce96d033cc21d1e5a3ac7f", "0x578980d6cac7ab262c40dfca650b1d2d259c1cca", "0x4a86009a36fcec5aa341ffceb3205a911fcf6f60",
		"0x9689992f5b5c09447f15906d8d11214944488341"}, Collector: "0x6fb4460e4bebf662fcd9bfa5ce6d6231732bb86c",
		// Same pattern on Robinhood Chain, but the amount is the user's own
		// setting (0.00005 to 0.001 ETH): priced from the call trace only,
		// never from a fixed figure. Was: a fixed 0.001 ETH forwarded to
		// this account on every transaction (traces of 2026-09-18).
		Tip: 0, TipTo: "0x569319680e2f921a23340d9a223c48f7b07c55bd"},
	// Banana Gun's EVM routers (DeFiLlama's dexs adapter); its fee is taken
	// inside the router like the others.
	// On the sampled Ethereum swaps the router's fee event (0x72015ace…,
	// what DeFiLlama sums) reads 0 and the wallet pays nothing beyond the
	// value and the gas in the block (balance N−1 → N): the fee is not in
	// the swap transaction, so the terminal component reads 0 here.
	{Slug: "banana-gun-ethereum", Name: "Banana Gun · Ethereum", Kind: "bot", Chain: "ethereum", Routers: []string{"0x3328f7f4a1d1c57c35df56bbf0c9dcafca309c49"},
		Note: "Banana Gun's Ethereum router logs a fee of 0 on every sampled swap, the wallet pays nothing beyond the value sent and the gas, and its other transfers show no fee either: no fee is visible on-chain for these swaps, so the terminal component reads 0."},
	{Slug: "banana-gun-base", Name: "Banana Gun · Base", Kind: "bot", Chain: "base", Routers: []string{"0x1fba6b0bbae2b74586fba407fb45bd4788b7b130"}},
	{Slug: "banana-gun-bnb", Name: "Banana Gun · BNB", Kind: "bot", Chain: "bnb", Routers: []string{"0x461efe0100be0682545972ebfc8b4a13253bd602"}},
	// Binance Wallet's swap router, the same address on BSC, Ethereum and
	// Base (Mobula attributes it; the transactions' `to` on 2026-09-19:
	// ~75 an hour on BSC, ~30 on Ethereum, ~10 on Base). It emits no
	// event of its own (an executor contract does), so the block sample
	// is the feed.
	{Slug: "binance-wallet-bnb", Name: "Binance Wallet · BNB", Kind: "app", Chain: "bnb", Routers: []string{"0xb300000b72deaeb607a12d5f54773d1c19c7028d"}, NoEvents: true},
	{Slug: "binance-wallet-ethereum", Name: "Binance Wallet · Ethereum", Kind: "app", Chain: "ethereum", Routers: []string{"0xb300000b72deaeb607a12d5f54773d1c19c7028d"}, NoEvents: true},
	{Slug: "binance-wallet-base", Name: "Binance Wallet · Base", Kind: "app", Chain: "base", Routers: []string{"0xb300000b72deaeb607a12d5f54773d1c19c7028d"}, NoEvents: true},
}

const nativeNote = "Swaps routed through the terminal's own contracts on this chain, read from their events (successful swaps: a failed transaction emits none, so the fail rate comes from a sample of blocks read in full, every transaction sent to the routers counted, reverted or not). Value given = what the user sent plus gas; value received = the tokens at the pool's state before the swap (v2 reserves, v3 / v4 previous price). The terminal's fee is paid inside the router as a native transfer: it is the residual after the pool and the gas. A fee the pool's own hook keeps (launchpad pools on Robinhood Chain and BNB) is a pool cost; a fixed inclusion tip the terminal adds to every transaction is network cost."

// nativeFeed polls the routers' logs per chain since the last block seen.
type nativeFeed struct {
	http   *http.Client
	cursor map[string]int64 // chain -> last block scanned
	polled map[string][2]int64
	box    map[string]*xinboxTx
	up     map[string]bool
}

// liquidityTopics: Uniswap v2 Mint, v3 Mint, v4 ModifyLiquidity — a
// transaction carrying one adds liquidity, it is not a swap.
var liquidityTopics = set(
	"0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f",
	"0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",
	"0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
)

// isNativeEVM: a row read from a terminal's own EVM routers.
func isNativeEVM(slug string) bool {
	for _, t := range evmTerminals {
		if t.Slug == slug {
			return true
		}
	}
	return false
}

// failScanBlocks: blocks read in full per chain per tick for the fail
// rate (BNB makes ~80 a minute, Robinhood Chain ~590, Base ~30, Ethereum
// ~5), drawn at random from the range the tick polled.
var failScanBlocks = map[string]int{"bnb": 8, "robinhood": 30, "base": 8, "ethereum": 2}

// failScan reads the sampled blocks in full: every transaction sent to a
// terminal's routers is an attempt, a reverted one (receipt status 0) a
// failed attempt, its gas the failed cost. A router emits no event on a
// revert, so the log feed alone never sees them.
func (f *nativeFeed) failScan(ctx context.Context, st *State, gas map[string]float64, now int64) {
	for _, c := range originChains {
		rng, ok := f.polled[c.slug]
		k := failScanBlocks[c.slug]
		if !ok || k == 0 || rng[1] < rng[0] {
			continue
		}
		byRouter := map[string]string{}
		noEvents := map[string]bool{}
		for _, t := range evmTerminals {
			if t.Chain != c.slug {
				continue
			}
			for _, r := range t.Routers {
				byRouter[r] = t.Slug
			}
			noEvents[t.Slug] = t.NoEvents
		}
		if len(byRouter) == 0 {
			continue
		}
		n := int(rng[1] - rng[0] + 1)
		if k > n {
			k = n
		}
		price := gas[c.gas]
		if c.gas == "" {
			price = 1
		}
		seen, failed := map[string]int{}, map[string]int{}
		read := 0 // blocks actually read: the sample's coverage of the range
		for _, off := range rand.Perm(n)[:k] {
			bn := rng[0] + int64(off)
			var blk struct {
				Transactions []struct {
					Hash string `json:"hash"`
					To   string `json:"to"`
				} `json:"transactions"`
			}
			if err := evmCall(ctx, f.http, c.rpc, "eth_getBlockByNumber", []any{"0x" + big.NewInt(bn).Text(16), true}, &blk); err != nil {
				log.Printf("[native] %s block %d: %v", c.slug, bn, err)
				continue
			}
			read++
			for _, tx := range blk.Transactions {
				slug := byRouter[strings.ToLower(tx.To)]
				if slug == "" {
					continue
				}
				var rc evmReceipt
				if err := evmCall(ctx, f.http, c.rpc, "eth_getTransactionReceipt", []any{tx.Hash}, &rc); err != nil {
					continue
				}
				seen[slug]++
				if rc.Status != "0x1" {
					failed[slug]++
					fee := float64(hexInt(rc.GasUsed)) * float64(hexInt(rc.EffectiveGasPrice)) / 1e18 * price
					st.Fails = append(st.Fails, failSample{Terminal: slug, Sig: tx.Hash, Time: now, FeeUSD: fee, Err: "reverted"})
				} else if noEvents[slug] {
					// The block sample is this terminal's feed.
					b := f.box[slug]
					if b == nil {
						b = &xinboxTx{}
						f.box[slug] = b
					}
					b.add(tx.Hash)
				}
			}
		}
		// Every terminal of the chain gets the sample's coverage (blocks read
		// over blocks in the polled range), hits or not: the pooled entry
		// scales its attempts and failures by it.
		done := map[string]bool{}
		for _, slug := range byRouter {
			if done[slug] {
				continue
			}
			done[slug] = true
			st.recordSample(slug, now, seen[slug], failed[slug], read, n)
		}
	}
}

type xinboxTx struct {
	seen      int
	reservoir []string
	total     int
	sigs      map[string]bool // hashes counted this tick (the log feed and the block sample can both see one)
}

func (b *xinboxTx) add(hash string) bool {
	if b.sigs == nil {
		b.sigs = map[string]bool{}
	}
	if b.sigs[hash] {
		return false
	}
	b.sigs[hash] = true
	b.seen++
	b.total++
	if len(b.reservoir) < reservoirSize {
		b.reservoir = append(b.reservoir, hash)
	} else if j := rand.Intn(b.total); j < reservoirSize {
		b.reservoir[j] = hash
	}
	return true
}

func newNativeFeed(httpc *http.Client, cursor map[string]int64) *nativeFeed {
	if cursor == nil {
		cursor = map[string]int64{}
	}
	return &nativeFeed{http: httpc, cursor: cursor, polled: map[string][2]int64{}, box: map[string]*xinboxTx{}, up: map[string]bool{}}
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
		// Ranges of at most 400 blocks (50 on Ethereum, where the public
		// nodes cap eth_getLogs at 50 blocks; ten minutes of chain), a few
		// per tick: a public RPC may refuse or redirect a heavier query.
		span := int64(400)
		if c.slug == "ethereum" {
			span = 50
		}
		start := from
		var logs []evmLog
		failed := false
		for chunk := 0; chunk < 5 && from <= head; chunk++ {
			to := from + span - 1
			if to > head {
				to = head
			}
			var part []evmLog
			if err := evmCall(ctx, f.http, c.logsRPC(), "eth_getLogs", []any{map[string]any{"fromBlock": "0x" + big.NewInt(from).Text(16), "toBlock": "0x" + big.NewInt(to).Text(16), "address": routers}}, &part); err != nil {
				log.Printf("[native] %s getLogs %d-%d: %v", c.slug, from, to, err)
				failed = true
				break
			}
			logs = append(logs, part...)
			f.cursor[c.slug] = to
			from = to + 1
		}
		f.up[c.slug] = !failed
		if f.cursor[c.slug] >= start {
			f.polled[c.slug] = [2]int64{start, f.cursor[c.slug]}
		} else {
			delete(f.polled, c.slug)
		}
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
			b.add(l.TxHash)
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
	nf.failScan(ctx, st, gas, now)
	for _, t := range evmTerminals {
		n0, sample, total := nf.drain(t.Slug)
		seen += n0
		st.record(t.Slug, now, n0, 0, 0, nil)
		// The quota accrues every tick (a sparse row, one swap a minute,
		// would otherwise need several active ticks per sample).
		quota[t.Slug] += perTick
		if cap := math.Max(3*perTick, 2); quota[t.Slug] > cap {
			quota[t.Slug] = cap
		}
		if total == 0 {
			continue
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
			if sw.Flag == "not_swap" {
				st.reject(t.Slug, rejectNotSwap)
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
	// A liquidity add (Binance Wallet's zap contract: part of the quote
	// swapped, the rest minted into the position) is not a swap. Only when
	// the transaction was not sent to the router itself: a hook adjusting
	// its own position during a routed swap must not hide the swap.
	toRouter := false
	for _, r := range t.Routers {
		if strings.EqualFold(tx.To, r) {
			toRouter = true
		}
	}
	if !toRouter {
		for _, l := range rc.Logs {
			if len(l.Topics) > 0 && liquidityTopics[l.Topics[0]] {
				return &Swap{Flag: "not_swap"}
			}
		}
	}
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
	if len(bought) == 0 && len(sold) == 0 {
		// The sender is not the trader (a relayer or a smart account): the
		// trader is whoever received the token from a pool (buy) or sent it
		// to one (sell), never a pool, a router or the collector.
		emitters := map[string]bool{}
		for i := range rc.Logs {
			if ev := parseSwapEv(&rc.Logs[i]); ev != nil {
				emitters[ev.pool] = true
			}
		}
		skip := func(a string) bool {
			if emitters[a] || a == t.Collector || a == "0x0000000000000000000000000000000000000000" || a == "0x000000000000000000000000000000000000dead" {
				return true
			}
			for _, r := range t.Routers {
				if a == r {
					return true
				}
			}
			return false
		}
		bestAmt := new(big.Int)
		for _, l := range rc.Logs {
			if len(l.Topics) != 3 || l.Topics[0] != topicTransfer {
				continue
			}
			erc, from, to, amt := strings.ToLower(l.Address), topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
			m := erc20(ctx, httpc, *c, erc)
			if _, ok := quoteUSD(m.symbol, *c, gas); ok || !m.ok {
				continue
			}
			if emitters[from] && !skip(to) && amt.Cmp(bestAmt) > 0 {
				user, bestAmt = to, amt
				bought, sold = map[string]*big.Int{erc: amt}, map[string]*big.Int{}
			} else if emitters[to] && !skip(from) && amt.Cmp(bestAmt) > 0 {
				user, bestAmt = from, amt
				bought, sold = map[string]*big.Int{}, map[string]*big.Int{erc: amt}
			}
		}
		if len(bought)+len(sold) > 0 {
			// Quote legs for that trader.
			quoteIn, quoteOut = 0, 0
			for _, l := range rc.Logs {
				if len(l.Topics) != 3 || l.Topics[0] != topicTransfer {
					continue
				}
				erc, from, to, amt := strings.ToLower(l.Address), topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
				m := erc20(ctx, httpc, *c, erc)
				q, ok := quoteUSD(m.symbol, *c, gas)
				if !ok || !m.ok {
					continue
				}
				if from == user {
					quoteIn += f(amt) * math.Pow10(-m.dec) * q
				} else if to == user {
					quoteOut += f(amt) * math.Pow10(-m.dec) * q
				}
			}
		}
	}
	valueWei := hexBig(tx.Value)
	sw := &Swap{Method: methodVersion, Sig: hash, Terminal: t.Slug, Slot: uint64(hexInt(rc.BlockNumber)), Time: now, User: user, Quote: "USD", QuoteUSD: 1, Chain: t.Chain, Pools: 1}
	zero := 0.0
	sw.OtherQ = &zero
	sw.NetworkQ = gasUSD
	bn := hexInt(rc.BlockNumber)
	// tipWei: the inclusion tip forwarded to the terminal's tip account,
	// exact from the call trace when the chain's endpoints serve one (the
	// tip is the user's own setting on Robinhood Chain); else the fixed
	// amount when that account did receive at least that much in the block.
	tipWei := func() *big.Int {
		if t.TipTo == "" {
			return nil
		}
		if calls, ok := evmTrace(ctx, httpc, *c, hash); ok {
			tip := new(big.Int)
			for _, vc := range calls {
				if vc.To == t.TipTo {
					tip.Add(tip, vc.Value)
				}
			}
			if tip.Sign() > 0 {
				return tip
			}
			return nil
		}
		if t.Tip <= 0 {
			return nil
		}
		var b0, b1 string
		if evmCall(ctx, httpc, c.rpc, "eth_getBalance", []any{t.TipTo, "0x" + big.NewInt(bn-1).Text(16)}, &b0) != nil || evmCall(ctx, httpc, c.rpc, "eth_getBalance", []any{t.TipTo, "0x" + big.NewInt(bn).Text(16)}, &b1) != nil {
			return nil
		}
		tip, _ := new(big.Float).Mul(big.NewFloat(t.Tip), big.NewFloat(1e18)).Int(nil)
		if new(big.Int).Sub(hexBig(b1), hexBig(b0)).Cmp(tip) < 0 {
			return nil
		}
		return tip
	}
	if token := pick(bought); token != "" && len(sold) == 0 {
		s, err := priceEvmSettlement(ctx, httpc, *c, hash, user, token, gas)
		if err != nil {
			return nil
		}
		// The native value at the rate the route itself swapped the gas
		// coin at when it did, else the exchange's price.
		price := gasPrice
		if s.NativeUSD > 0 {
			price = s.NativeUSD
		}
		value := f(valueWei) / 1e18 * price
		// Buy: given = native value or quote ERC20 from the user, plus
		// gas; the fixed tip inside the value is network cost.
		given := value + quoteIn
		if given <= 0 {
			return &Swap{Flag: "unpriced_no_quote_in"}
		}
		if tip := tipWei(); tip != nil && valueWei.Cmp(tip) > 0 {
			tipUSD := f(tip) / 1e18 * price
			given -= tipUSD
			sw.NetworkQ += tipUSD
		}
		sw.Side, sw.Mint, sw.Tokens, sw.Venue, sw.Pools, sw.Hops, sw.PoolVault = "buy", token, s.Tokens, s.Venue, s.Pools, s.Hops, s.Pool
		sw.UserQ = given + sw.NetworkQ
		sw.PoolQ = s.PoolInUSD
		other := s.OtherUSD // a launchpad's protocol fee (four.meme)
		sw.OtherQ = &other
		fee := given - s.PoolInUSD - s.OtherUSD
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
		price := gasPrice
		if s.NativeUSD > 0 {
			price = s.NativeUSD
		}
		// A sale sends no value, except the terminal's fixed tip: network
		// cost, and not part of what the user received.
		tipUSD := 0.0
		if valueWei.Sign() > 0 && t.TipTo != "" {
			tipUSD = f(valueWei) / 1e18 * price
			sw.NetworkQ += tipUSD
		}
		// Received: quote ERC20 to the user, else the native balance change
		// across the block plus the gas and the tip paid out of it.
		recv := quoteOut
		if recv == 0 {
			var b0, b1 string
			if evmCall(ctx, httpc, c.rpc, "eth_getBalance", []any{user, "0x" + big.NewInt(bn-1).Text(16)}, &b0) != nil || evmCall(ctx, httpc, c.rpc, "eth_getBalance", []any{user, "0x" + big.NewInt(bn).Text(16)}, &b1) != nil {
				return &Swap{Flag: "unpriced_balance"}
			}
			delta := new(big.Float).SetInt(new(big.Int).Sub(hexBig(b1), hexBig(b0)))
			d, _ := delta.Float64()
			recv = d/1e18*price + gasUSD + tipUSD
			if recv <= 0 {
				return &Swap{Flag: "unpriced_no_receive"}
			}
		}
		sw.Side, sw.Mint, sw.Tokens, sw.Venue, sw.Pools, sw.Hops, sw.PoolVault = "sell", token, s.Tokens, s.Venue, s.Pools, s.Hops, s.Pool
		sw.UserQ = recv
		sw.PoolQ = s.PoolInUSD
		other := s.OtherUSD // a launchpad's protocol fee (four.meme)
		sw.OtherQ = &other
		fee := s.PoolInUSD - s.OtherUSD - recv
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
