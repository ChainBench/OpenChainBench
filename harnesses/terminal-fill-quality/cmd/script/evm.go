package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
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
			last = errors.New(redactURL(err.Error(), url))
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

// redactURL replaces a full endpoint URL inside an error message (Go's
// url.Error carries the request URL, keyed path or query included) with its
// host, so a keyed endpoint never reaches the log.
func redactURL(msg, rawURL string) string {
	if rawURL == "" {
		return msg
	}
	host := rawURL
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if i := strings.IndexAny(host, "/?"); i >= 0 {
		host = host[:i]
	}
	msg = strings.ReplaceAll(msg, rawURL, host)
	// a keyed query or path segment quoted on its own
	if i := strings.Index(rawURL, "?"); i >= 0 {
		msg = strings.ReplaceAll(msg, rawURL[i:], "?<redacted>")
	}
	return msg
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
	// Arc's gas coin is USDC; the chain logs its native moves as ERC20
	// Transfers of a pseudo-token (18 decimals) with no code to ask.
	if c.slug == "arc" && token == arcPseudo {
		return erc20Meta{dec: 18, symbol: "USDC", ok: true}
	}
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
	// A stable's name proves nothing (an 18-decimal "USDC" on Arc sold
	// 2,594 of itself for $3.39): on chains whose stables are listed, only
	// the listed addresses price at $1, any other "USDC" stays unpriced.
	if list, known := stableAddrs[c.slug]; known {
		if q, isStable := quoteUSD(m.symbol, c, nil); isStable && q == 1 && !list[strings.ToLower(token)] {
			m.symbol = "?" + m.symbol
		}
	}
	erc20Cache.Lock()
	if len(erc20Cache.m) >= poolCacheMax {
		erc20Cache.m = map[string]erc20Meta{}
	}
	if m.ok { // a transient RPC error must not brand the token for the process's life
		erc20Cache.m[key] = m
	}
	erc20Cache.Unlock()
	return m
}

// stableAddrs: the stables that price at $1, by chain (Circle / Tether /
// Maker / Ethena / Paxos / World Liberty / First Digital deployments and
// Robinhood Chain's USDG, Arc's native USDC and its pseudo-token).
var stableAddrs = map[string]map[string]bool{
	"bnb":       set("0x55d398326f99059ff775485246999027b3197955", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", "0xe9e7cea3dedca5984780bafc599bd69add087d56", "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3", "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34"),
	"ethereum":  set("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7", "0x6b175474e89094c44da98b954eedeac495271d0f", "0xdc035d45d973e3ec169d2276ddab16f1e407384f", "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", "0x6c3ea9036406852006290770bedfcaba0e23a0e8", "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409"),
	"base":      set("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", "0x820c137fa70c8691f0e44dc420a5e53c168921dc", "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34"),
	"robinhood": set("0x5fc5360d0400a0fd4f2af552add042d716f1d168"),
	"arc":       set(arcUSDC, arcPseudo),
}

// Arc logs a native USDC move twice: as the 6-decimal token and as the
// 18-decimal pseudo-token of the gas coin.
const (
	arcUSDC   = "0x3600000000000000000000000000000000000000"
	arcPseudo = "0xfffffffffffffffffffffffffffffffffffffffe"
)

// nativeV4Quote: a v4 pool holds the gas coin itself, so a swap against
// ETH logs no ERC20 transfer for the quote leg. When no ERC20 flow of the
// manager matches the quote (to 0.5 %), the quote is the gas coin at the
// exchange's price, USD per wei; any ERC20 flow of half the quote or more
// through the manager means a token leg instead (left unpriced). Sells of
// BasedBot's users on Robinhood Chain against ETH-quoted v4 pools read
// no_quote_leg before this.
func nativeV4Quote(c originChain, gas map[string]float64, ev *swapEv, quoteRaw *big.Int, flows map[string]*big.Int) (float64, bool) {
	if ev.kind != "v4" || c.gas == "" || quoteRaw == nil || quoteRaw.Sign() <= 0 {
		return 0, false
	}
	p, ok := gas[c.gas]
	if !ok || p <= 0 {
		return 0, false
	}
	for _, amt := range flows {
		if amt != nil && amt.Cmp(new(big.Int).Div(quoteRaw, big.NewInt(2))) >= 0 {
			return 0, false // an ERC20 of that order moved through the manager: the quote is a token leg the passes above could not price, not the gas coin
		}
	}
	return p * 1e-18, true
}

// logsSpan: the widest eth_getLogs block range the chain's log node
// accepts (HyperEVM's public RPC 1,000; the keyed Robinhood Chain node
// 10,000; 3,000 elsewhere, the public nodes' comfortable range).
func (c originChain) logsSpan() int64 {
	switch c.slug {
	case "hyperevm":
		return 1000
	case "robinhood":
		return 9000
	}
	return 3000
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
	PoolInUSD float64 // quote paid into the token pools, USD (sales: paid out to the route, after any hook fee)
	HookUSD   float64 // sales: quote the pool's hook kept out of the swap's output (a pool cost)
	OtherUSD  float64 // a launchpad's protocol fee on the trade (four.meme's 1 %), `other`
	NativeUSD float64 // USD per wrapped gas coin at the route's own stable ↔ wrapped hop pool's pre-trade mid (the executed rate as fallback), 0 if none
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
	tokenOuts := map[string][]*big.Int{}         // token paid out, by sender (each transfer on the way to the recipient)
	tokenAll := map[string][]*big.Int{}          // token paid out, by sender (every transfer: a hook's cut among them)
	intoPool := map[string]map[string]*big.Int{} // receiver -> erc20 -> amount
	// Only the token flow that reached the recipient counts: to them, or to
	// whoever forwarded to them (a router). A taxed token swapping its own
	// tax on the same pool inside our transaction is not our pool.
	// Walking the transfers backwards from the recipient, an address is
	// on the way when it forwarded to the way what it had received (its
	// budget), so a forwarding hop of any depth counts and a side flow
	// (the token's own tax sale) never does.
	ours := map[int]bool{}
	toUser := map[string]*big.Int{recipient: new(big.Int).Lsh(big.NewInt(1), 200)}
	for i := len(rc.Logs) - 1; i >= 0; i-- {
		l := &rc.Logs[i]
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer || strings.ToLower(l.Address) != token {
			continue
		}
		from, to, amt := topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
		b := toUser[to]
		if b == nil || b.Cmp(amt) < 0 {
			continue
		}
		b.Sub(b, amt)
		if toUser[from] == nil {
			toUser[from] = new(big.Int)
		}
		toUser[from].Add(toUser[from], amt)
		ours[i] = true
	}
	for i := range rc.Logs {
		l := &rc.Logs[i]
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer {
			continue
		}
		erc, from, to, amt := strings.ToLower(l.Address), topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
		if erc == token {
			if to == recipient {
				tokensRaw.Add(tokensRaw, amt)
			}
			// The sender's whole outflow (a taxed token's cut to its
			// treasury is part of the pool's payout) and, one by one, the
			// transfers on the way to the recipient.
			if tokenFrom[from] == nil {
				tokenFrom[from] = new(big.Int)
			}
			tokenFrom[from].Add(tokenFrom[from], amt)
			tokenAll[from] = append(tokenAll[from], amt)
			if ours[i] {
				tokenOuts[from] = append(tokenOuts[from], amt)
			}
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
				// A v4 hook that keeps part of the output: what went on
				// is short of the swap's output by exactly another
				// transfer out of the manager (its cut, at most a
				// quarter); the recipient's fewer tokens make it a pool
				// cost.
				if diff := new(big.Int).Sub(o, t); ev.kind == "v4" && diff.Sign() > 0 && diff.Cmp(new(big.Int).Div(o, big.NewInt(4))) <= 0 {
					for _, a := range tokenAll[ev.pool] {
						if a.Cmp(diff) == 0 {
							match = true
						}
					}
				}
			}
			if match {
				pools = append(pools, tokenPool{ev: ev, side: side, quote: ev.in[1-side], outTk: o})
				break
			}
		}
	}
	if len(pools) == 0 {
		// No pool paid the token out: a four.meme curve buy?
		for _, tr := range fourTrades(rc.Logs, token) {
			if tr.buy && tokenFrom[tr.manager] != nil {
				var hc float64
				out.NativeUSD, hc = nativeRate(ctx, httpc, c, rc.Logs, evs, gas, out.BlockNum)
				priceFourMeme(ctx, httpc, c, &out, tr, token, meta.dec, gas)
				out.PoolInUSD += hc // the stable-to-gas-coin hop's own cost
				return out, nil
			}
		}
		for _, tr := range rhTrades(rc.Logs, true, tokenFrom) {
			priceRHCurve(ctx, httpc, c, &out, tr, token, meta.dec, gas, rc.Logs)
			return out, nil
		}
		out.Unpriced = "no_pool"
		return out, nil
	}
	sort.Slice(pools, func(i, j int) bool { return pools[i].outTk.Cmp(pools[j].outTk) > 0 })
	main := pools[0]
	out.Pools = len(pools)
	quoteSum := new(big.Int) // the token pools' quotes together, for a hop split across them
	for _, p := range pools {
		quoteSum.Add(quoteSum, p.quote)
	}
	out.Venue, out.Pool = "uniswap-"+main.ev.kind, main.ev.pool
	if main.ev.kind == "v4" {
		out.Pool += ":" + main.ev.id
	}
	// USD per raw unit of the pool's quote: a priced ERC20 transferred into
	// the pool (v2 / v3: the pair; v4: the manager), else through the hop
	// that paid the quote out.
	var usdPerRaw func(ev *swapEv, quoteRaw *big.Int, depth int) (float64, int, bool)
	usdPerRaw = func(ev *swapEv, quoteRaw *big.Int, depth int) (float64, int, bool) {
		// The priced ERC20 whose inflow equals the quote first (Arc logs
		// the same USDC move twice, as the 6-decimal token and as the
		// 18-decimal native pseudo-token: only one matches the event).
		for pass := 0; pass < 2; pass++ {
			for erc, amt := range intoPool[ev.pool] {
				if erc == arcPseudo && intoPool[ev.pool][arcUSDC] != nil {
					continue // Arc's twin log of the same move: the 6-decimal token is the one the event counts
				}
				qm := erc20(ctx, httpc, c, erc)
				q, ok := quoteUSD(qm.symbol, c, gas)
				if !qm.ok || !ok {
					continue
				}
				if pass == 0 && amt.Cmp(quoteRaw) != 0 {
					continue
				}
				if amt.Cmp(quoteRaw) >= 0 || ev.kind != "v4" {
					return q * math.Pow10(-qm.dec), 0, true
				}
			}
		}
		if depth >= 2 {
			return 0, 0, false
		}
		// The hop: an earlier swap that paid exactly the quote out.
		for pass := 0; pass < 2; pass++ {
			for _, h := range evs {
				if h == ev || h.index >= ev.index {
					continue
				}
				for side := 0; side < 2; side++ {
					if h.out[side].Sign() > 0 && near(h.out[side], quoteRaw, quoteSum, pass == 1) && h.in[1-side].Sign() > 0 {
						if u, hops, ok := usdPerRaw(h, h.in[1-side], depth+1); ok {
							return u * f(h.in[1-side]) / f(h.out[side]), hops + 1, true // USD per raw unit of the hop's output
						}
					}
				}
			}
		}
		if u, ok := nativeV4Quote(c, gas, ev, quoteRaw, intoPool[ev.pool]); ok {
			return u, 0, true
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
			// A split pool must price on its own quote leg: another pool's
			// unit price (USDC's for a pool quoted in ETH) would be absurd.
			u2, _, ok := usdPerRaw(p.ev, p.quote, 0)
			if !ok {
				out.Unpriced = "no_quote_leg_split"
				return out, nil
			}
			u = u2
		}
		out.PoolInUSD += f(p.quote) * u
	}
	// A buy paid in the gas coin: the native leg at the hop pool's mid
	// before the hop, the hop's own cost into pool.
	var hopCost float64
	out.NativeUSD, hopCost = nativeRateFor(ctx, httpc, c, rc.Logs, evs, gas, upr, out.BlockNum)
	out.PoolInUSD += hopCost
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
		if err != nil {
			// An unreachable node is not a quiet pool. Kept apart so a
			// rate-limited endpoint cannot read as "this market had no
			// previous trade" (HyperEVM's public RPC answers two
			// address-filtered getLogs then throttles), the same split
			// rhcurve.go makes between curve_logs and curve_no_prev.
			out.Unpriced = main.ev.kind + "_logs"
			log.Printf("[evm] %s previous trade on pool %s: %s", c.slug, main.ev.pool, redactURL(err.Error(), c.logsRPC()[0]))
			return out, nil
		}
		if sqrt == nil || sqrt.Sign() == 0 {
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
	outOfPool := map[string]map[string]*big.Int{}         // sender -> erc20 -> amount
	outTo := map[string]map[string]map[string]*big.Int{}  // sender -> erc20 -> recipient -> amount
	backTo := map[string]map[string]map[string]*big.Int{} // recipient -> erc20 -> sender -> amount (what came back)
	// Only the user's own token flow counts: from them, or from whoever
	// they handed the tokens to (a router); a taxed token selling its own
	// tax on the same pool inside our transaction is not our sale.
	// Walking the transfers forward from the user, an address is on the
	// way when it forwards what it had received from the way (its
	// budget): a forwarding hop of any depth counts, a side flow never.
	ours := map[int]bool{}
	fromUser := map[string]*big.Int{user: new(big.Int).Lsh(big.NewInt(1), 200)}
	for i := range rc.Logs {
		l := &rc.Logs[i]
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer || strings.ToLower(l.Address) != token {
			continue
		}
		from, to, amt := topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
		b := fromUser[from]
		if b == nil || b.Cmp(amt) < 0 {
			continue
		}
		b.Sub(b, amt)
		if fromUser[to] == nil {
			fromUser[to] = new(big.Int)
		}
		fromUser[to].Add(fromUser[to], amt)
		ours[i] = true
	}
	for i := range rc.Logs {
		l := &rc.Logs[i]
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
			if ours[i] {
				tokenIns[to] = append(tokenIns[to], amt)
			}
			continue
		}
		if outOfPool[from] == nil {
			outOfPool[from] = map[string]*big.Int{}
			outTo[from] = map[string]map[string]*big.Int{}
		}
		if outOfPool[from][erc] == nil {
			outOfPool[from][erc] = new(big.Int)
			outTo[from][erc] = map[string]*big.Int{}
		}
		outOfPool[from][erc].Add(outOfPool[from][erc], amt)
		if outTo[from][erc][to] == nil {
			outTo[from][erc][to] = new(big.Int)
		}
		outTo[from][erc][to].Add(outTo[from][erc][to], amt)
		if backTo[to] == nil {
			backTo[to] = map[string]map[string]*big.Int{}
		}
		if backTo[to][erc] == nil {
			backTo[to][erc] = map[string]*big.Int{}
		}
		if backTo[to][erc][from] == nil {
			backTo[to][erc][from] = new(big.Int)
		}
		backTo[to][erc][from].Add(backTo[to][erc][from], amt)
	}
	// delivered: the quote that left the pool for the route. A v4 hook may
	// keep part of the swap's output (its own transfer out of the manager,
	// next to the one to the router: the launchpad hooks on Robinhood
	// Chain and BNB take 1 – 4 %): the largest recipient's amount is what
	// went on, the rest is the hook's fee, a cost of that pool.
	delivered := func(ev *swapEv, quoteRaw *big.Int) (*big.Int, *big.Int) {
		if ev.kind != "v4" {
			return quoteRaw, new(big.Int)
		}
		for erc, byTo := range outTo[ev.pool] {
			if len(byTo) < 2 || outOfPool[ev.pool][erc] == nil || outOfPool[ev.pool][erc].Cmp(quoteRaw) < 0 {
				continue // not this swap's quote (another ERC20's smaller flow)
			}
			// The largest recipient got what went on; the shortfall to the
			// swap's output is the hook's when one other recipient got
			// exactly that (or the others together, net of what they sent
			// straight back: a hook that takes and returns through the
			// manager). The router's own round trip into the next hop on
			// the same manager is a gross amount here, never netted.
			largest, largestTo := new(big.Int), ""
			for to, a := range byTo {
				if a.Cmp(largest) > 0 {
					largest, largestTo = a, to
				}
			}
			if largest.Cmp(quoteRaw) >= 0 {
				continue
			}
			rest := new(big.Int).Sub(quoteRaw, largest)
			if rest.Cmp(new(big.Int).Div(quoteRaw, big.NewInt(4))) > 0 {
				continue
			}
			others := new(big.Int)
			exact := false
			for to, a := range byTo {
				if to == largestTo {
					continue
				}
				if a.Cmp(rest) == 0 {
					exact = true
				}
				n := new(big.Int).Set(a)
				if back := backTo[ev.pool][erc][to]; back != nil {
					n.Sub(n, back)
				}
				if n.Sign() > 0 {
					others.Add(others, n)
				}
			}
			if exact || others.Cmp(rest) == 0 {
				return largest, rest
			}
		}
		return quoteRaw, new(big.Int)
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
		// No pool took the token: a four.meme curve sale?
		for _, tr := range fourTrades(rc.Logs, token) {
			if !tr.buy && tokenTo[tr.manager] != nil {
				var hc float64
				out.NativeUSD, hc = nativeRate(ctx, httpc, c, rc.Logs, evs, gas, out.BlockNum)
				priceFourMeme(ctx, httpc, c, &out, tr, token, meta.dec, gas)
				if hc > 0 && out.PoolInUSD > hc {
					out.PoolInUSD -= hc
				}
				return out, nil
			}
		}
		for _, tr := range rhTrades(rc.Logs, false, tokenTo) {
			priceRHCurve(ctx, httpc, c, &out, tr, token, meta.dec, gas, rc.Logs)
			return out, nil
		}
		out.Unpriced = "no_pool"
		return out, nil
	}
	sort.Slice(pools, func(i, j int) bool { return pools[i].inTk.Cmp(pools[j].inTk) > 0 })
	main := pools[0]
	out.Pools = len(pools)
	quoteSum := new(big.Int) // the token pools' quotes together, for a hop split across them
	for _, p := range pools {
		quoteSum.Add(quoteSum, p.quote)
	}
	out.Venue, out.Pool = "uniswap-"+main.ev.kind, main.ev.pool
	if main.ev.kind == "v4" {
		out.Pool += ":" + main.ev.id
	}
	// USD per raw unit of the quote the pool paid out: a priced ERC20 the
	// pool sent, else through the next hop (the swap that took the quote
	// in and paid a priced asset out).
	var usdPerRaw func(ev *swapEv, quoteRaw *big.Int, depth int) (float64, int, bool)
	usdPerRaw = func(ev *swapEv, quoteRaw *big.Int, depth int) (float64, int, bool) {
		// The priced ERC20 whose outflow equals the quote first (Arc logs
		// the same USDC move twice, 6-decimal token and 18-decimal native
		// pseudo-token: only one matches the event).
		for pass := 0; pass < 2; pass++ {
			for erc, amt := range outOfPool[ev.pool] {
				if erc == arcPseudo && outOfPool[ev.pool][arcUSDC] != nil {
					continue // Arc's twin log of the same move
				}
				qm := erc20(ctx, httpc, c, erc)
				q, ok := quoteUSD(qm.symbol, c, gas)
				if !qm.ok || !ok {
					continue
				}
				if pass == 0 && amt.Cmp(quoteRaw) != 0 && amt.Cmp(ev.out[0]) != 0 && amt.Cmp(ev.out[1]) != 0 {
					continue
				}
				if amt.Cmp(quoteRaw) >= 0 || ev.kind != "v4" {
					return q * math.Pow10(-qm.dec), 0, true
				}
			}
		}
		if depth >= 2 {
			return 0, 0, false
		}
		for pass := 0; pass < 2; pass++ {
			for _, h := range evs {
				if h == ev || h.index <= ev.index {
					continue
				}
				for side := 0; side < 2; side++ {
					if h.in[side].Sign() > 0 && near(h.in[side], quoteRaw, quoteSum, pass == 1) && h.out[1-side].Sign() > 0 {
						hq, _ := delivered(h, h.out[1-side])
						if u, hops, ok := usdPerRaw(h, hq, depth+1); ok {
							return u * f(hq) / f(h.in[side]), hops + 1, true // USD per raw unit of the hop's input
						}
					}
				}
			}
		}
		if u, ok := nativeV4Quote(c, gas, ev, quoteRaw, outOfPool[ev.pool]); ok {
			return u, 0, true
		}
		return 0, 0, false
	}
	mainQuote, _ := delivered(main.ev, main.quote)
	upr, hops, ok := usdPerRaw(main.ev, mainQuote, 0)
	if !ok {
		out.Unpriced = "no_quote_leg"
		return out, nil
	}
	out.Hops = hops
	for _, p := range pools {
		q, hook := delivered(p.ev, p.quote)
		u := upr
		if p.ev != main.ev {
			u2, _, ok := usdPerRaw(p.ev, q, 0)
			if !ok {
				out.Unpriced = "no_quote_leg_split"
				return out, nil
			}
			u = u2
		}
		out.PoolInUSD += f(q) * u // here: the quote the pools paid out to the route, USD
		out.HookUSD += f(hook) * u
	}
	// A sale paid out in the gas coin: the native leg at the hop pool's mid
	// before the hop; the hop's own cost comes off what the pools paid.
	var hopCost float64
	out.NativeUSD, hopCost = nativeRateFor(ctx, httpc, c, rc.Logs, evs, gas, upr, out.BlockNum)
	if hopCost > 0 && out.PoolInUSD > hopCost {
		out.PoolInUSD -= hopCost
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
		if err != nil {
			// An unreachable node is not a quiet pool. Kept apart so a
			// rate-limited endpoint cannot read as "this market had no
			// previous trade" (HyperEVM's public RPC answers two
			// address-filtered getLogs then throttles), the same split
			// rhcurve.go makes between curve_logs and curve_no_prev.
			out.Unpriced = main.ev.kind + "_logs"
			log.Printf("[evm] %s previous trade on pool %s: %s", c.slug, main.ev.pool, redactURL(err.Error(), c.logsRPC()[0]))
			return out, nil
		}
		if sqrt == nil || sqrt.Sign() == 0 {
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

// valueCall is one internal call that moved gas coins.
type valueCall struct {
	From, To string
	Value    *big.Int
}

// evmTrace lists the internal value transfers of a transaction
// (debug_traceTransaction, callTracer) when an endpoint of the chain
// serves it: QuickNode on Robinhood Chain, drpc's public BSC node; an
// endpoint without the method is skipped like any other error.
func evmTrace(ctx context.Context, httpc *http.Client, c originChain, hash string) ([]valueCall, bool) {
	type call struct {
		From  string `json:"from"`
		To    string `json:"to"`
		Value string `json:"value"`
		Calls []call `json:"calls"`
	}
	var root call
	if err := evmCall(ctx, httpc, c.traceRPC(), "debug_traceTransaction", []any{hash, map[string]any{"tracer": "callTracer"}}, &root); err != nil {
		return nil, false
	}
	var out []valueCall
	var walk func(c *call)
	walk = func(c *call) {
		if v := hexBig(c.Value); v.Sign() > 0 && c.To != "" {
			out = append(out, valueCall{From: strings.ToLower(c.From), To: strings.ToLower(c.To), Value: v})
		}
		for i := range c.Calls {
			walk(&c.Calls[i])
		}
	}
	walk(&root)
	return out, true
}

// nativeRateFor applies nativeRate only when the pool leg was not itself
// valued at the exchange's gas price (a token pool quoted in WBNB /
// WETH): then both legs share the exchange's print and the route's own
// rate would move value between the buckets for nothing.
func nativeRateFor(ctx context.Context, httpc *http.Client, c originChain, logs []evmLog, evs []*swapEv, gas map[string]float64, upr float64, block int64) (rate, hopCost float64) {
	if p, ok := gas[c.gas]; ok && p > 0 && math.Abs(upr/(p*1e-18)-1) < 1e-9 {
		return 0, 0
	}
	return nativeRate(ctx, httpc, c, logs, evs, gas, block)
}

// nativeRate: USD per wrapped gas coin for a native leg of the user (BNB
// sent, ETH received), from the route's own hop between a stable and the
// wrapped coin (a pair contract, or a v4 manager paying one and taking the
// other). The rate is that hop pool's mid before the hop (v2: the Sync
// reserves minus the hop's amounts; v3 / v4: the price left by the
// previous swap on the pool), so the hop's own LP fee and impact stay a
// cost of the trade: hopCost is that cost in USD (wrapped in × mid minus
// stable out on a buy, stable in minus wrapped out × mid on a sale) and
// the caller books it in pool. When the pool's state cannot be read the
// hop's realized rate is used and hopCost is 0 (the hop's cost then leaves
// the loss, as before). 0 when the route has no such hop, or the rate is
// more than 5 % away from the exchange's (not a plain hop).
func nativeRate(ctx context.Context, httpc *http.Client, c originChain, logs []evmLog, evs []*swapEv, gas map[string]float64, block int64) (rate, hopCost float64) {
	if c.gas == "" {
		return 0, 0
	}
	emit := map[string]bool{}
	for _, ev := range evs {
		emit[ev.pool] = true
	}
	type flow struct {
		stIn, stOut, wIn, wOut             float64 // ui units
		stInRaw, stOutRaw, wInRaw, wOutRaw *big.Int
		stDec, wDec                        int
	}
	flows := map[string]*flow{}
	for i := range logs {
		l := &logs[i]
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer {
			continue
		}
		erc, from, to, amt := strings.ToLower(l.Address), topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
		if !emit[from] && !emit[to] {
			continue
		}
		m := erc20(ctx, httpc, c, erc)
		if !m.ok {
			continue
		}
		q, ok := quoteUSD(m.symbol, c, gas)
		stable, wrapped := ok && q == 1, isWrappedGas(m.symbol, c)
		if !stable && !wrapped {
			continue
		}
		ui := f(amt) * math.Pow10(-m.dec)
		for _, a := range []string{from, to} {
			if !emit[a] {
				continue
			}
			fl := flows[a]
			if fl == nil {
				fl = &flow{stInRaw: new(big.Int), stOutRaw: new(big.Int), wInRaw: new(big.Int), wOutRaw: new(big.Int)}
				flows[a] = fl
			}
			switch {
			case stable && a == to:
				fl.stIn += ui
				fl.stInRaw.Add(fl.stInRaw, amt)
				fl.stDec = m.dec
			case stable:
				fl.stOut += ui
				fl.stOutRaw.Add(fl.stOutRaw, amt)
				fl.stDec = m.dec
			case a == to:
				fl.wIn += ui
				fl.wInRaw.Add(fl.wInRaw, amt)
				fl.wDec = m.dec
			default:
				fl.wOut += ui
				fl.wOutRaw.Add(fl.wOutRaw, amt)
				fl.wDec = m.dec
			}
		}
	}
	ref := gas[c.gas]
	best, bestStable, bestPool, bestBuy := 0.0, 0.0, "", false
	for pool, fl := range flows {
		var r, st float64
		buy := false
		switch {
		case fl.stIn > 0 && fl.wOut > 0 && fl.stOut == 0 && fl.wIn == 0: // stable in, wrapped out (a sale's native leg)
			r, st = fl.stIn/fl.wOut, fl.stIn
		case fl.wIn > 0 && fl.stOut > 0 && fl.stIn == 0 && fl.wOut == 0: // wrapped in, stable out (a buy's native leg)
			r, st, buy = fl.stOut/fl.wIn, fl.stOut, true
		}
		if r > 0 && (ref <= 0 || math.Abs(r/ref-1) <= 0.05) && st > bestStable {
			best, bestStable, bestPool, bestBuy = r, st, pool, buy
		}
	}
	if best == 0 {
		return 0, 0
	}
	// The hop pool's mid before the hop: the swap event on that pool whose
	// amounts are the hop's (a v4 manager emits every pool's events).
	fl := flows[bestPool]
	wRaw, stRaw := fl.wInRaw, fl.stOutRaw
	if !bestBuy {
		wRaw, stRaw = fl.wOutRaw, fl.stInRaw
	}
	var hop *swapEv
	var sideW int
	for _, ev := range evs {
		if ev.pool != bestPool {
			continue
		}
		for side := 0; side < 2; side++ {
			inW, outSt := ev.in[side], ev.out[1-side]
			if !bestBuy {
				inW, outSt = ev.out[side], ev.in[1-side]
			}
			if inW != nil && outSt != nil && inW.Cmp(wRaw) == 0 && outSt.Cmp(stRaw) == 0 {
				hop, sideW = ev, side
			}
		}
	}
	if hop == nil {
		return best, 0
	}
	sideS := 1 - sideW
	mid := 0.0 // ui stable per ui wrapped, before the hop
	switch hop.kind {
	case "v2":
		var sync *evmLog
		for i := range logs {
			l := &logs[i]
			if strings.ToLower(l.Address) == hop.pool && len(l.Topics) == 1 && (l.Topics[0] == topicV2Sync || l.Topics[0] == topicAeroSync) && hexInt(l.LogIndex) < hop.index {
				sync = l
			}
		}
		if sync == nil {
			return best, 0
		}
		r := [2]*big.Int{word(sync.Data, 0), word(sync.Data, 1)}
		var pre [2]*big.Int
		for s := 0; s < 2; s++ {
			pre[s] = new(big.Int).Add(new(big.Int).Sub(r[s], hop.in[s]), hop.out[s])
			if pre[s].Sign() <= 0 {
				return best, 0
			}
		}
		mid = f(pre[sideS]) * math.Pow10(-fl.stDec) / (f(pre[sideW]) * math.Pow10(-fl.wDec))
	default:
		var extra []string
		if hop.kind == "v4" {
			extra = []string{hop.id}
		}
		sqrt, err := prevSqrtPrice(ctx, httpc, c, hop.pool, hop.log.Topics[0], extra, block, hop.index)
		if err != nil || sqrt == nil || sqrt.Sign() == 0 {
			return best, 0
		}
		p10 := sqrtToPrice(sqrt) // raw token1 per raw token0
		if sideW == 0 {
			mid = p10 * math.Pow10(fl.wDec-fl.stDec)
		} else {
			mid = math.Pow10(fl.wDec-fl.stDec) / p10
		}
	}
	if mid <= 0 || (ref > 0 && math.Abs(mid/ref-1) > 0.05) {
		return best, 0
	}
	if bestBuy {
		hopCost = fl.wIn*mid - fl.stOut
	} else {
		hopCost = fl.stIn - fl.wOut*mid
	}
	if hopCost < 0 {
		hopCost = 0
	}
	return mid, hopCost
}

// isWrappedGas: the wrapped gas coin of the chain (WBNB on BNB, WETH on
// the Ethereum-priced chains, WHYPE on HyperEVM).
func isWrappedGas(sym string, c originChain) bool {
	switch sym {
	case "WETH", "WBNB", "WHYPE":
		return strings.HasPrefix(c.gas, sym[1:]+"-")
	}
	return false
}

// near: a hop's amount matches the quote when it equals it, or sits within
// 1.5 % of it (a router skimming between hops, second pass only), or matches the quotes of
// every token pool together (a hop split across pools).
func near(a, quote, quoteSum *big.Int, loose bool) bool {
	within := func(x, y *big.Int) bool {
		if y.Sign() == 0 {
			return false
		}
		if x.Cmp(y) == 0 {
			return true
		}
		if !loose {
			return false
		}
		d := new(big.Int).Abs(new(big.Int).Sub(x, y))
		return d.Mul(d, big.NewInt(66)).Cmp(y) <= 0 // within 1.5 %
	}
	return within(a, quote) || within(a, quoteSum)
}

// prevSqrtPrice: the sqrtPriceX96 left by the last swap on the pool
// before ours (same block, lower log index, or an earlier block within
// the lookback), read from the pool's own logs.
func prevSqrtPrice(ctx context.Context, httpc *http.Client, c originChain, pool, topic string, extra []string, block, logIndex int64) (*big.Int, error) {
	topics := []any{topic}
	for _, e := range extra {
		topics = append(topics, e)
	}
	// Back in chunks the chain's node accepts (HyperEVM's public RPC caps
	// eth_getLogs at 1,000 blocks, the keyed Robinhood Chain node at
	// 10,000): the first chunk covers most pools, a quiet one (Arc, small
	// v4 pools) gets up to ten, the filter by pool and id keeping it light.
	var logs []evmLog
	span := c.logsSpan()
	to := block
	for chunk := 0; chunk < 10 && to >= 0; chunk++ {
		from := to - span
		if from < 0 {
			from = 0
		}
		var part []evmLog
		if err := evmCall(ctx, httpc, c.logsRPC(), "eth_getLogs", []any{map[string]any{"address": pool, "topics": topics, "fromBlock": "0x" + big.NewInt(from).Text(16), "toBlock": "0x" + big.NewInt(to).Text(16)}}, &part); err != nil && !strings.Contains(err.Error(), "empty result") {
			return nil, err
		}
		logs = append(logs, part...)
		found := false
		for i := range part {
			b, ix := hexInt(part[i].BlockNumber), hexInt(part[i].LogIndex)
			if b < block || (b == block && ix < logIndex) {
				found = true
			}
		}
		if found || from == 0 {
			break
		}
		to = from - 1
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
