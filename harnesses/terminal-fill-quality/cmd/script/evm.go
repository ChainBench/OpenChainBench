package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// EVM side of the cross-chain settlements: a Relay solver buys the token
// on the destination chain (Robinhood Chain, BNB, Base, Ethereum, Arc,
// HyperEVM) and transfers it to the user. The settlement receipt gives,
// exactly, the tokens delivered (ERC20 Transfer to the user), the pool(s)
// that paid them out (the swap events whose emitter transferred the
// token), the quote paid into them, and the pools' own logs give their
// state before our swap:
//
//	Uniswap v2 forks (PancakeSwap v2, Aerodrome / Velodrome): the Sync
//	  event after the swap minus the swap's amounts = the reserves before
//	  it (same receipt, exact).
//	Uniswap v3 forks (PancakeSwap v3 included): the sqrtPriceX96 left by
//	  the previous Swap on the pool is the price before ours (the pool's
//	  own logs, exact).
//	Uniswap v4: same on the PoolManager, keyed by the pool id.
//
// Which side of the pool is the token is settled by reconciling the
// event's amounts with the transfers of the receipt, never by a token0()
// call, so a pool whose ordering we misread cannot price a swap. A final
// pool quoted in a third asset (WETH inside the PoolManager, a tokenized
// stock) is priced through the route's own hop: the swap that paid that
// asset out, and what was paid into it.

const (
	topicTransfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
	topicV2Swap   = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
	topicV2Sync   = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1"
	topicAeroSwap = "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b" // Aerodrome / Velodrome v2: same fields as Uniswap v2
	topicAeroSync = "0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a"
	topicV3Swap   = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
	topicPcsV3    = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83"
	topicV4Swap   = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
)

type evmLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	LogIndex    string   `json:"logIndex"`
	TxHash      string   `json:"transactionHash"`
}

type evmReceipt struct {
	Status            string   `json:"status"`
	BlockNumber       string   `json:"blockNumber"`
	GasUsed           string   `json:"gasUsed"`
	EffectiveGasPrice string   `json:"effectiveGasPrice"`
	Logs              []evmLog `json:"logs"`
}

type evmTx struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Value string `json:"value"`
}

// evmCall runs one JSON-RPC call against the chain's public endpoints in
// order; the first one that answers with a result wins.
func evmCall(ctx context.Context, httpc *http.Client, urls []string, method string, params []any, out any) error {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	var last error = errors.New("no endpoint")
	for _, url := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 OpenChainBench/1.0")
		resp, err := httpc.Do(req)
		if err != nil {
			last = err
			continue
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		var env struct {
			Result json.RawMessage `json:"result"`
			Error  *rpcError       `json:"error"`
		}
		if json.Unmarshal(data, &env) != nil || env.Error != nil || len(env.Result) == 0 || string(env.Result) == "null" {
			if env.Error != nil {
				last = errors.New(env.Error.Message)
			} else {
				last = errors.New("empty result")
			}
			continue
		}
		return json.Unmarshal(env.Result, out)
	}
	return last
}

func hexInt(s string) int64 {
	n, ok := new(big.Int).SetString(strings.TrimPrefix(s, "0x"), 16)
	if !ok {
		return 0
	}
	return n.Int64()
}

func hexBig(s string) *big.Int {
	n, ok := new(big.Int).SetString(strings.TrimPrefix(s, "0x"), 16)
	if !ok {
		return new(big.Int)
	}
	return n
}

// word returns the i-th 32-byte word of ABI data as an unsigned big.Int.
func word(data string, i int) *big.Int {
	h := strings.TrimPrefix(data, "0x")
	if len(h) < 64*(i+1) {
		return new(big.Int)
	}
	n, _ := new(big.Int).SetString(h[64*i:64*(i+1)], 16)
	if n == nil {
		return new(big.Int)
	}
	return n
}

// sword: the same word read as a two's-complement signed integer.
func sword(data string, i int) *big.Int {
	n := word(data, i)
	if n.Bit(255) == 1 {
		n.Sub(n, new(big.Int).Lsh(big.NewInt(1), 256))
	}
	return n
}

func topicAddr(t string) string { return "0x" + strings.ToLower(t[len(t)-40:]) }

func f(n *big.Int) float64 { v, _ := new(big.Float).SetInt(n).Float64(); return v }

// ERC20 metadata cache (decimals, symbol), one eth_call each per token.
var erc20Cache = struct {
	sync.Mutex
	m map[string]erc20Meta
}{m: map[string]erc20Meta{}}

type erc20Meta struct {
	dec    int
	symbol string
	ok     bool
}

func erc20(ctx context.Context, httpc *http.Client, c originChain, token string) erc20Meta {
	key := c.slug + ":" + token
	erc20Cache.Lock()
	m, hit := erc20Cache.m[key]
	erc20Cache.Unlock()
	if hit {
		return m
	}
	var decHex, symHex string
	if err := evmCall(ctx, httpc, c.rpc, "eth_call", []any{map[string]any{"to": token, "data": "0x313ce567"}, "latest"}, &decHex); err == nil && len(decHex) >= 66 {
		m.dec = int(hexInt(decHex))
		m.ok = m.dec >= 0 && m.dec <= 36
	}
	if err := evmCall(ctx, httpc, c.rpc, "eth_call", []any{map[string]any{"to": token, "data": "0x95d89b41"}, "latest"}, &symHex); err == nil && len(symHex) >= 130 {
		// ABI string: offset, length, bytes
		l := int(hexInt("0x" + strings.TrimPrefix(symHex, "0x")[64:128]))
		if raw, err := hex.DecodeString(strings.TrimPrefix(symHex, "0x")[128:]); err == nil && l <= len(raw) {
			m.symbol = strings.ToUpper(strings.TrimRight(string(raw[:l]), "\x00"))
		}
	}
	erc20Cache.Lock()
	if len(erc20Cache.m) >= poolCacheMax {
		erc20Cache.m = map[string]erc20Meta{}
	}
	erc20Cache.m[key] = m
	erc20Cache.Unlock()
	return m
}

// quoteUSD prices a quote token: stables at $1, wrapped gas coins at the
// Coinbase spot of the chain's gas token.
func quoteUSD(sym string, c originChain, gas map[string]float64) (float64, bool) {
	switch sym {
	case "USDC", "USDT", "USDG", "USD1", "DAI", "USDS", "USDE", "PYUSD", "USDC.E", "USDBC", "FDUSD", "USDH":
		return 1, true
	case "WETH", "ETH", "WBNB", "BNB", "WHYPE", "HYPE":
		if c.gas == "" {
			return 0, false
		}
		p, ok := gas[c.gas]
		return p, ok && p > 0
	}
	return 0, false
}

// swapEv is one swap event of a receipt, reduced to its amounts: for v2
// forks the in / out amounts per side, for v3 / v4 the signed deltas
// (positive = paid into the pool, negative = paid out).
type swapEv struct {
	log   *evmLog
	kind  string // v2 | v3 | v4
	pool  string // emitter (v4: PoolManager); id = v4 pool id
	id    string
	in    [2]*big.Int
	out   [2]*big.Int
	index int64
}

func parseSwapEv(l *evmLog) *swapEv {
	if len(l.Topics) == 0 {
		return nil
	}
	ev := &swapEv{log: l, pool: strings.ToLower(l.Address), index: hexInt(l.LogIndex)}
	switch l.Topics[0] {
	case topicV2Swap, topicAeroSwap:
		ev.kind = "v2"
		ev.in = [2]*big.Int{word(l.Data, 0), word(l.Data, 1)}
		ev.out = [2]*big.Int{word(l.Data, 2), word(l.Data, 3)}
	case topicV3Swap, topicPcsV3, topicV4Swap:
		ev.kind = "v3"
		if l.Topics[0] == topicV4Swap && len(l.Topics) > 1 {
			ev.kind, ev.id = "v4", l.Topics[1]
		}
		a0, a1 := sword(l.Data, 0), sword(l.Data, 1)
		ev.in, ev.out = [2]*big.Int{new(big.Int), new(big.Int)}, [2]*big.Int{new(big.Int), new(big.Int)}
		// v3: amounts are the pool's balance deltas (positive = paid in).
		// v4: amounts are the swapper's balance deltas (positive = received
		// from the pool), the opposite sign.
		for i, a := range []*big.Int{a0, a1} {
			paidIn := a.Sign() >= 0
			if ev.kind == "v4" {
				paidIn = !paidIn
			}
			if paidIn {
				ev.in[i] = new(big.Int).Abs(a)
			} else {
				ev.out[i] = new(big.Int).Abs(a)
			}
		}
	default:
		return nil
	}
	return ev
}

// evmSettlement is what the destination receipt says about a settlement.
type evmSettlement struct {
	Tokens    float64 // delivered to the user, ui units
	TokenSym  string
	Venue     string  // uniswap-v2 | uniswap-v3 | uniswap-v4 (forks included)
	Pool      string  // main pool (v4: PoolManager:poolId)
	Pools     int     // pools that paid the token out (split routes)
	Hops      int     // hops priced through
	PoolInUSD float64 // quote paid into the token pools, USD
	MidUSD    float64 // main pool's price before our swap, USD per token
	RefSrc    string
	GasUSD    float64 // destination gas (paid by the solver)
	Priced    bool
	Unpriced  string // why not
	BlockNum  int64
}

// priceEvmSettlement reads the settlement on the destination chain.
func priceEvmSettlement(ctx context.Context, httpc *http.Client, c originChain, hash, recipient, token string, gas map[string]float64) (evmSettlement, error) {
	var out evmSettlement
	var rc evmReceipt
	if err := evmCall(ctx, httpc, c.rpc, "eth_getTransactionReceipt", []any{hash}, &rc); err != nil {
		return out, err
	}
	if rc.Status != "0x1" {
		out.Unpriced = "reverted"
		return out, nil
	}
	out.BlockNum = hexInt(rc.BlockNumber)
	if p, ok := gas[c.gas]; ok {
		out.GasUSD = float64(hexInt(rc.GasUsed)) * float64(hexInt(rc.EffectiveGasPrice)) / 1e18 * p
	}
	recipient, token = strings.ToLower(recipient), strings.ToLower(token)
	meta := erc20(ctx, httpc, c, token)
	if !meta.ok {
		out.Unpriced = "token_meta"
		return out, nil
	}
	out.TokenSym = meta.symbol
	// Transfers of the receipt: the token's, by sender; every ERC20's, by
	// (token, receiver), for the quote legs.
	tokensRaw := new(big.Int)
	tokenFrom := map[string]*big.Int{}           // token paid out, by sender (total)
	tokenOuts := map[string][]*big.Int{}         // token paid out, by sender (each transfer)
	intoPool := map[string]map[string]*big.Int{} // receiver -> erc20 -> amount
	for _, l := range rc.Logs {
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer {
			continue
		}
		erc, from, to, amt := strings.ToLower(l.Address), topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
		if erc == token {
			if to == recipient {
				tokensRaw.Add(tokensRaw, amt)
			}
			if tokenFrom[from] == nil {
				tokenFrom[from] = new(big.Int)
			}
			tokenFrom[from].Add(tokenFrom[from], amt)
			tokenOuts[from] = append(tokenOuts[from], amt)
			continue
		}
		if intoPool[to] == nil {
			intoPool[to] = map[string]*big.Int{}
		}
		if intoPool[to][erc] == nil {
			intoPool[to][erc] = new(big.Int)
		}
		intoPool[to][erc].Add(intoPool[to][erc], amt)
	}
	if tokensRaw.Sign() == 0 {
		out.Unpriced = "no_delivery"
		return out, nil
	}
	out.Tokens = f(tokensRaw) * math.Pow10(-meta.dec)
	// Swap events; the token pools are those whose emitter paid the token
	// out. On a v4 PoolManager several pools share the emitter: the token
	// pool is the swap whose out amount is what the manager paid out.
	var evs []*swapEv
	for i := range rc.Logs {
		if ev := parseSwapEv(&rc.Logs[i]); ev != nil {
			evs = append(evs, ev)
		}
	}
	type tokenPool struct {
		ev    *swapEv
		side  int      // token side of the event
		quote *big.Int // raw quote paid in
		outTk *big.Int // raw tokens paid out
	}
	var pools []tokenPool
	for _, ev := range evs {
		paid := tokenFrom[ev.pool]
		if paid == nil || paid.Sign() == 0 {
			continue
		}
		// Token side: the out amount of the event that equals what the
		// emitter transferred in the token (the whole outflow, or one of
		// its transfers on a v4 manager routing several pools). A hop that
		// shares the emitter never matches.
		for side := 0; side < 2; side++ {
			o := ev.out[side]
			if o.Sign() <= 0 || ev.in[1-side].Sign() <= 0 {
				continue
			}
			match := o.Cmp(paid) == 0
			for _, t := range tokenOuts[ev.pool] {
				if o.Cmp(t) == 0 {
					match = true
				}
			}
			if match {
				pools = append(pools, tokenPool{ev: ev, side: side, quote: ev.in[1-side], outTk: o})
				break
			}
		}
	}
	if len(pools) == 0 {
		out.Unpriced = "no_pool"
		return out, nil
	}
	sort.Slice(pools, func(i, j int) bool { return pools[i].outTk.Cmp(pools[j].outTk) > 0 })
	main := pools[0]
	out.Pools = len(pools)
	out.Venue, out.Pool = "uniswap-"+main.ev.kind, main.ev.pool
	if main.ev.kind == "v4" {
		out.Pool += ":" + main.ev.id
	}
	// USD per raw unit of the pool's quote: a priced ERC20 transferred into
	// the pool (v2 / v3: the pair; v4: the manager), else through the hop
	// that paid the quote out.
	var usdPerRaw func(ev *swapEv, quoteRaw *big.Int, depth int) (float64, int, bool)
	usdPerRaw = func(ev *swapEv, quoteRaw *big.Int, depth int) (float64, int, bool) {
		for erc, amt := range intoPool[ev.pool] {
			qm := erc20(ctx, httpc, c, erc)
			q, ok := quoteUSD(qm.symbol, c, gas)
			if !qm.ok || !ok {
				continue
			}
			if amt.Cmp(quoteRaw) == 0 || ev.kind != "v4" {
				return q * math.Pow10(-qm.dec), 0, true
			}
		}
		if depth >= 2 {
			return 0, 0, false
		}
		// The hop: an earlier swap that paid exactly the quote out.
		for _, h := range evs {
			if h == ev || h.index >= ev.index {
				continue
			}
			for side := 0; side < 2; side++ {
				if h.out[side].Sign() > 0 && h.out[side].Cmp(quoteRaw) == 0 && h.in[1-side].Sign() > 0 {
					if u, hops, ok := usdPerRaw(h, h.in[1-side], depth+1); ok {
						return u * f(h.in[1-side]) / f(quoteRaw), hops + 1, true
					}
				}
			}
		}
		return 0, 0, false
	}
	upr, hops, ok := usdPerRaw(main.ev, main.quote, 0)
	if !ok {
		out.Unpriced = "no_quote_leg"
		return out, nil
	}
	out.Hops = hops
	for _, p := range pools {
		u := upr
		if p.ev != main.ev {
			if u2, _, ok := usdPerRaw(p.ev, p.quote, 0); ok {
				u = u2
			}
		}
		out.PoolInUSD += f(p.quote) * u
	}
	// The main pool's price before our swap, raw quote per raw token.
	var midRaw float64
	switch main.ev.kind {
	case "v2":
		var sync *evmLog
		for i := range rc.Logs {
			l := &rc.Logs[i]
			if strings.ToLower(l.Address) == main.ev.pool && len(l.Topics) == 1 && (l.Topics[0] == topicV2Sync || l.Topics[0] == topicAeroSync) && hexInt(l.LogIndex) < main.ev.index {
				sync = l // the Sync just before the Swap event carries the post-swap reserves
			}
		}
		if sync == nil {
			out.Unpriced = "no_sync"
			return out, nil
		}
		r := [2]*big.Int{word(sync.Data, 0), word(sync.Data, 1)}
		var pre [2]*big.Int
		for s := 0; s < 2; s++ {
			pre[s] = new(big.Int).Add(new(big.Int).Sub(r[s], main.ev.in[s]), main.ev.out[s])
			if pre[s].Sign() <= 0 {
				out.Unpriced = "v2_reserves"
				return out, nil
			}
		}
		midRaw = f(pre[1-main.side]) / f(pre[main.side])
		out.RefSrc = "reserves"
	default:
		var extra []string
		if main.ev.kind == "v4" {
			extra = []string{main.ev.id}
		}
		sqrt, err := prevSqrtPrice(ctx, httpc, c, main.ev.pool, main.ev.log.Topics[0], extra, out.BlockNum, main.ev.index)
		if err != nil || sqrt == nil || sqrt.Sign() == 0 {
			out.Unpriced = main.ev.kind + "_no_prev"
			return out, nil
		}
		p10 := sqrtToPrice(sqrt) // raw token1 per raw token0
		if main.side == 0 {
			midRaw = p10
		} else {
			midRaw = 1 / p10
		}
		out.RefSrc = "reserves"
	}
	if midRaw <= 0 {
		out.Unpriced = "no_mid"
		return out, nil
	}
	out.MidUSD = midRaw * math.Pow10(meta.dec) * upr // raw quote per raw token → USD per ui token
	out.Priced = true
	return out, nil
}

// priceEvmOriginSale reads a deposit that sold a token on the origin
// chain (the user's transaction: token into a pool, quote out to Relay):
// the tokens sold, the pool that took them, the quote it paid out, and
// the pool's state before the swap. The mirror of priceEvmSettlement.
func priceEvmOriginSale(ctx context.Context, httpc *http.Client, c originChain, hash, user, token string, gas map[string]float64) (evmSettlement, error) {
	var out evmSettlement
	var rc evmReceipt
	if err := evmCall(ctx, httpc, c.rpc, "eth_getTransactionReceipt", []any{hash}, &rc); err != nil {
		return out, err
	}
	if rc.Status != "0x1" {
		out.Unpriced = "reverted"
		return out, nil
	}
	out.BlockNum = hexInt(rc.BlockNumber)
	if p, ok := gas[c.gas]; ok {
		out.GasUSD = float64(hexInt(rc.GasUsed)) * float64(hexInt(rc.EffectiveGasPrice)) / 1e18 * p
	}
	user, token = strings.ToLower(user), strings.ToLower(token)
	meta := erc20(ctx, httpc, c, token)
	if !meta.ok {
		out.Unpriced = "token_meta"
		return out, nil
	}
	out.TokenSym = meta.symbol
	tokensRaw := new(big.Int)
	tokenTo := map[string]*big.Int{}
	tokenIns := map[string][]*big.Int{}
	outOfPool := map[string]map[string]*big.Int{} // sender -> erc20 -> amount
	for _, l := range rc.Logs {
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer {
			continue
		}
		erc, from, to, amt := strings.ToLower(l.Address), topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
		if erc == token {
			if from == user {
				tokensRaw.Add(tokensRaw, amt)
			}
			if tokenTo[to] == nil {
				tokenTo[to] = new(big.Int)
			}
			tokenTo[to].Add(tokenTo[to], amt)
			tokenIns[to] = append(tokenIns[to], amt)
			continue
		}
		if outOfPool[from] == nil {
			outOfPool[from] = map[string]*big.Int{}
		}
		if outOfPool[from][erc] == nil {
			outOfPool[from][erc] = new(big.Int)
		}
		outOfPool[from][erc].Add(outOfPool[from][erc], amt)
	}
	if tokensRaw.Sign() == 0 {
		out.Unpriced = "no_token_sent"
		return out, nil
	}
	out.Tokens = f(tokensRaw) * math.Pow10(-meta.dec)
	var evs []*swapEv
	for i := range rc.Logs {
		if ev := parseSwapEv(&rc.Logs[i]); ev != nil {
			evs = append(evs, ev)
		}
	}
	type tokenPool struct {
		ev    *swapEv
		side  int
		quote *big.Int // raw quote paid out
		inTk  *big.Int // raw tokens taken in
	}
	var pools []tokenPool
	for _, ev := range evs {
		got := tokenTo[ev.pool]
		if got == nil || got.Sign() == 0 {
			continue
		}
		for side := 0; side < 2; side++ {
			i := ev.in[side]
			if i.Sign() <= 0 || ev.out[1-side].Sign() <= 0 {
				continue
			}
			match := i.Cmp(got) == 0
			for _, t := range tokenIns[ev.pool] {
				if i.Cmp(t) == 0 {
					match = true
				}
			}
			if match {
				pools = append(pools, tokenPool{ev: ev, side: side, quote: ev.out[1-side], inTk: i})
				break
			}
		}
	}
	if len(pools) == 0 {
		out.Unpriced = "no_pool"
		return out, nil
	}
	sort.Slice(pools, func(i, j int) bool { return pools[i].inTk.Cmp(pools[j].inTk) > 0 })
	main := pools[0]
	out.Pools = len(pools)
	out.Venue, out.Pool = "uniswap-"+main.ev.kind, main.ev.pool
	if main.ev.kind == "v4" {
		out.Pool += ":" + main.ev.id
	}
	// USD per raw unit of the quote the pool paid out: a priced ERC20 the
	// pool sent, else through the next hop (the swap that took the quote
	// in and paid a priced asset out).
	var usdPerRaw func(ev *swapEv, quoteRaw *big.Int, depth int) (float64, int, bool)
	usdPerRaw = func(ev *swapEv, quoteRaw *big.Int, depth int) (float64, int, bool) {
		for erc, amt := range outOfPool[ev.pool] {
			qm := erc20(ctx, httpc, c, erc)
			q, ok := quoteUSD(qm.symbol, c, gas)
			if !qm.ok || !ok {
				continue
			}
			if amt.Cmp(quoteRaw) == 0 || ev.kind != "v4" {
				return q * math.Pow10(-qm.dec), 0, true
			}
		}
		if depth >= 2 {
			return 0, 0, false
		}
		for _, h := range evs {
			if h == ev || h.index <= ev.index {
				continue
			}
			for side := 0; side < 2; side++ {
				if h.in[side].Sign() > 0 && h.in[side].Cmp(quoteRaw) == 0 && h.out[1-side].Sign() > 0 {
					if u, hops, ok := usdPerRaw(h, h.out[1-side], depth+1); ok {
						return u * f(h.out[1-side]) / f(quoteRaw), hops + 1, true
					}
				}
			}
		}
		return 0, 0, false
	}
	upr, hops, ok := usdPerRaw(main.ev, main.quote, 0)
	if !ok {
		out.Unpriced = "no_quote_leg"
		return out, nil
	}
	out.Hops = hops
	for _, p := range pools {
		u := upr
		if p.ev != main.ev {
			if u2, _, ok := usdPerRaw(p.ev, p.quote, 0); ok {
				u = u2
			}
		}
		out.PoolInUSD += f(p.quote) * u // here: the quote the pools paid out, USD
	}
	var midRaw float64
	switch main.ev.kind {
	case "v2":
		var sync *evmLog
		for i := range rc.Logs {
			l := &rc.Logs[i]
			if strings.ToLower(l.Address) == main.ev.pool && len(l.Topics) == 1 && (l.Topics[0] == topicV2Sync || l.Topics[0] == topicAeroSync) && hexInt(l.LogIndex) < main.ev.index {
				sync = l
			}
		}
		if sync == nil {
			out.Unpriced = "no_sync"
			return out, nil
		}
		r := [2]*big.Int{word(sync.Data, 0), word(sync.Data, 1)}
		var pre [2]*big.Int
		for s := 0; s < 2; s++ {
			pre[s] = new(big.Int).Add(new(big.Int).Sub(r[s], main.ev.in[s]), main.ev.out[s])
			if pre[s].Sign() <= 0 {
				out.Unpriced = "v2_reserves"
				return out, nil
			}
		}
		midRaw = f(pre[1-main.side]) / f(pre[main.side])
		out.RefSrc = "reserves"
	default:
		var extra []string
		if main.ev.kind == "v4" {
			extra = []string{main.ev.id}
		}
		sqrt, err := prevSqrtPrice(ctx, httpc, c, main.ev.pool, main.ev.log.Topics[0], extra, out.BlockNum, main.ev.index)
		if err != nil || sqrt == nil || sqrt.Sign() == 0 {
			out.Unpriced = main.ev.kind + "_no_prev"
			return out, nil
		}
		p10 := sqrtToPrice(sqrt)
		if main.side == 0 {
			midRaw = p10
		} else {
			midRaw = 1 / p10
		}
		out.RefSrc = "reserves"
	}
	if midRaw <= 0 {
		out.Unpriced = "no_mid"
		return out, nil
	}
	out.MidUSD = midRaw * math.Pow10(meta.dec) * upr
	out.Priced = true
	return out, nil
}

// prevSqrtPrice: the sqrtPriceX96 left by the last swap on the pool
// before ours (same block, lower log index, or an earlier block within
// the lookback), read from the pool's own logs.
func prevSqrtPrice(ctx context.Context, httpc *http.Client, c originChain, pool, topic string, extra []string, block, logIndex int64) (*big.Int, error) {
	const lookback = 3000
	from := block - lookback
	if from < 0 {
		from = 0
	}
	topics := []any{topic}
	for _, e := range extra {
		topics = append(topics, e)
	}
	var logs []evmLog
	if err := evmCall(ctx, httpc, c.rpc, "eth_getLogs", []any{map[string]any{"address": pool, "topics": topics, "fromBlock": "0x" + big.NewInt(from).Text(16), "toBlock": "0x" + big.NewInt(block).Text(16)}}, &logs); err != nil {
		return nil, err
	}
	sort.Slice(logs, func(i, j int) bool {
		bi, bj := hexInt(logs[i].BlockNumber), hexInt(logs[j].BlockNumber)
		if bi != bj {
			return bi < bj
		}
		return hexInt(logs[i].LogIndex) < hexInt(logs[j].LogIndex)
	})
	var prev *evmLog
	for i := range logs {
		l := &logs[i]
		b, ix := hexInt(l.BlockNumber), hexInt(l.LogIndex)
		if b < block || (b == block && ix < logIndex) {
			prev = l
		}
	}
	if prev == nil {
		return nil, nil
	}
	return word(prev.Data, 2), nil // sqrtPriceX96 is the third word in v3, PancakeSwap v3 and v4 Swap events
}

// sqrtToPrice: (sqrtPriceX96 / 2^96)^2 = raw token1 per raw token0.
func sqrtToPrice(sqrt *big.Int) float64 {
	s := new(big.Float).SetInt(sqrt)
	s.Quo(s, new(big.Float).SetInt(new(big.Int).Lsh(big.NewInt(1), 96)))
	v, _ := s.Float64()
	return v * v
}

// originGivenUSD reads what the user sent on an EVM origin chain: the
// deposit's native value, else the ERC20 it transferred, priced with the
// same sources as everything else (stables $1, gas coins Coinbase).
// ok is false when the asset cannot be priced (a token: Relay's own
// valuation is then the only figure).
func originGivenUSD(ctx context.Context, httpc *http.Client, c originChain, hash, user string, gas map[string]float64) (float64, bool) {
	var tx evmTx
	if err := evmCall(ctx, httpc, c.rpc, "eth_getTransactionByHash", []any{hash}, &tx); err != nil {
		return 0, false
	}
	if v := hexBig(tx.Value); v.Sign() > 0 {
		p, ok := gas[c.gas]
		if c.gas == "" {
			p, ok = 1, true
		}
		if !ok {
			return 0, false
		}
		return f(v) / 1e18 * p, true
	}
	var rc evmReceipt
	if err := evmCall(ctx, httpc, c.rpc, "eth_getTransactionReceipt", []any{hash}, &rc); err != nil {
		return 0, false
	}
	user = strings.ToLower(user)
	for _, l := range rc.Logs {
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer || topicAddr(l.Topics[1]) != user {
			continue
		}
		m := erc20(ctx, httpc, c, strings.ToLower(l.Address))
		q, ok := quoteUSD(m.symbol, c, gas)
		if !m.ok || !ok {
			return 0, false
		}
		return f(word(l.Data, 0)) * math.Pow10(-m.dec) * q, true
	}
	return 0, false
}
