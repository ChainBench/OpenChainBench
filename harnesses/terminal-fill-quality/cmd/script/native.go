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
// the fail rate comes from failScan's blocks read in full); a random
// sample is read.
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
	// FromSet: the router is shared (a chain's own aggregator); only the
	// swaps sent by wallets this app funded through Relay (State.Funded)
	// are the app's. SenderTopic says, per event signature, which topic
	// carries the sender, so the log feed filters without a transaction
	// read; the block sample filters on the transaction's from.
	FromSet     string
	SenderTopic map[string]int
	// DropLoops: wallets trading the same token both ways four times or
	// more in the window are farming (Binance Alpha volume on Base, fee-free
	// round trips): their swaps stay out of the row's statistics.
	DropLoops bool
	Note      string
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
	// the swap transaction; the row waits (one side only, no fee on it).
	{Slug: "banana-gun-ethereum", Name: "Banana Gun · Ethereum", Kind: "bot", Chain: "ethereum", Routers: []string{"0x3328f7f4a1d1c57c35df56bbf0c9dcafca309c49"},
		Note: "Banana Gun's Ethereum router logs a fee of 0 on every sampled swap, the wallet pays nothing beyond the value sent and the gas, and its other transfers show no fee either: no fee is visible on-chain for these swaps, so the terminal component reads 0."},
	{Slug: "banana-gun-base", Name: "Banana Gun · Base", Kind: "bot", Chain: "base", Routers: []string{"0x1fba6b0bbae2b74586fba407fb45bd4788b7b130"}},
	{Slug: "banana-gun-bnb", Name: "Banana Gun · BNB", Kind: "bot", Chain: "bnb", Routers: []string{"0x461efe0100be0682545972ebfc8b4a13253bd602"}},
	// Binance Wallet's swap router, the same address on BSC, Ethereum and
	// Base (Mobula attributes it; the transactions' `to` on 2026-09-19:
	// ~75 an hour on BSC, ~30 on Ethereum, ~10 on Base). It emits no
	// event of its own (an executor contract does), so the block sample
	// is the feed.
	// BasedBot on Robinhood Chain: the wallets it funds from Solana through
	// Relay (EIP-7702 accounts) trade on the chain's shared router
	// 0x7ab338… (its swap event names the sender in topic 1) and its sell
	// contract 0xe33e9e… (sender in topic 3); only those wallets' swaps are
	// BasedBot's. The router forwards about 1 % of the trade to fee and
	// referral accounts before the pool: the residual reads as the fee.
	{Slug: "basedbot-robinhood", Name: "BasedBot · Robinhood Chain", Kind: "bot", Chain: "robinhood",
		Routers:     []string{"0x7ab338fde039feb0da5a38d90d1a08fff1c31af0", "0xe33e9e479df8802cb0866d5d05258bec4cf62948"},
		FromSet:     "basedbot",
		SenderTopic: map[string]int{"0x2ed5a8749a7e3a68a074750cc77850912a0708dc62ab7ea42b0c3e5beb36f017": 1, "0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37": 3},
		Note:        "BasedBot's users on Robinhood Chain: the wallets it funded from Solana through Relay, trading on the chain's router (shared with other front ends: only those wallets' swaps count). Value given = what the wallet sent plus gas; received = the tokens at the pool's state before the swap; the router's transfers to its fee and referral accounts (about 1 % of the trade) are the fee, the residual after the pool and gas."},
	// The same router family on Base (0xbce806…), Ethereum (0xf92807…) and
	// BNB (0xeada78…): same swap event, sender in topic 1, same funded-set
	// filter (2026-09-19: 9 of 40 senders on Base and 15 of 30 on BNB were
	// BasedBot-funded wallets: shared routers).
	{Slug: "basedbot-base", Name: "BasedBot · Base", Kind: "bot", Chain: "base",
		Routers: []string{"0xbce80645b0e9b0ab52648b0d23f37db56616ea93"}, FromSet: "basedbot",
		SenderTopic: map[string]int{"0x2ed5a8749a7e3a68a074750cc77850912a0708dc62ab7ea42b0c3e5beb36f017": 1},
		Note:        "BasedBot's users on Base: the wallets it funded from Solana through Relay, trading on its router family's contract there (shared with other front ends: only those wallets' swaps count); the router's fee and referral transfers (about 1 %) are the fee, the residual after the pool and gas."},
	{Slug: "basedbot-bnb", Name: "BasedBot · BNB", Kind: "bot", Chain: "bnb",
		Routers: []string{"0xeada78153c3f0524663c9029faf0734d08dda599"}, FromSet: "basedbot",
		SenderTopic: map[string]int{"0x2ed5a8749a7e3a68a074750cc77850912a0708dc62ab7ea42b0c3e5beb36f017": 1},
		Note:        "BasedBot's users on BNB: the wallets it funded from Solana through Relay, trading on its router family's contract there (shared with other front ends: only those wallets' swaps count); the router's fee and referral transfers (about 1 %) are the fee, the residual after the pool and gas."},
	{Slug: "basedbot-ethereum", Name: "BasedBot · Ethereum", Kind: "bot", Chain: "ethereum",
		Routers: []string{"0xf9280799c85d376e0425f6fb38e4a674e8bedb56"}, FromSet: "basedbot",
		SenderTopic: map[string]int{"0x2ed5a8749a7e3a68a074750cc77850912a0708dc62ab7ea42b0c3e5beb36f017": 1},
		Note:        "BasedBot's users on Ethereum: the wallets it funded from Solana through Relay, trading on its router family's contract there (a few swaps an hour); the router's fee and referral transfers (about 1 %) are the fee, the residual after the pool and gas."},
	// GMGN's Ethereum and Base routers: the parent transactions of the
	// internal transfers to its fee collector (DeFiLlama's gmgnai adapter,
	// Alchemy asset transfers on 2026-09-21: 94 an hour on Ethereum, 126 on
	// Base), the same swap-end events as on BNB (0x205442d6…, 0x3145c7c5…).
	{Slug: "gmgn-ethereum", Name: "GMGN · Ethereum", Kind: "app", Chain: "ethereum", Routers: []string{"0x4313c378cc91ea583c91387b9216e2c03096b27f"}, Collector: "0xb8159ba378904f803639d274cec79f788931c9c8"},
	{Slug: "gmgn-base", Name: "GMGN · Base", Kind: "app", Chain: "base", Routers: []string{"0xd8ba9d1a99fc21f0eca24e9b85737c28a194a4e2"}, Collector: "0xb8159ba378904f803639d274cec79f788931c9c8"},
	// Maestro's EVM router, one vanity address on every chain, emits one
	// event per swap (0x86c70604…) and forwards the fee to Maestro's wallet
	// (DeFiLlama's maestro adapter: 0xB0999731…) as an internal transfer:
	// the residual after the pool and gas. 2026-09-21: Robinhood Chain 57
	// swaps an hour, BNB 31, Base 9, Ethereum 7.
	{Slug: "maestro-bnb", Name: "Maestro · BNB", Kind: "bot", Chain: "bnb", Routers: []string{"0x00000000e91fc5bad977c0cc4ad60557c06886a2"}, Collector: "0xb0999731f7c2581844658a9d2ced1be0077b7397"},
	{Slug: "maestro-ethereum", Name: "Maestro · Ethereum", Kind: "bot", Chain: "ethereum", Routers: []string{"0x00000000e91fc5bad977c0cc4ad60557c06886a2"}, Collector: "0xb0999731f7c2581844658a9d2ced1be0077b7397"},
	{Slug: "maestro-base", Name: "Maestro · Base", Kind: "bot", Chain: "base", Routers: []string{"0x00000000e91fc5bad977c0cc4ad60557c06886a2"}, Collector: "0xb0999731f7c2581844658a9d2ced1be0077b7397"},
	{Slug: "maestro-robinhood", Name: "Maestro · Robinhood Chain", Kind: "bot", Chain: "robinhood", Routers: []string{"0x00000000e91fc5bad977c0cc4ad60557c06886a2"}, Collector: "0xb0999731f7c2581844658a9d2ced1be0077b7397"},
	// Bloom's EVM bot: one vanity router on every chain, one event per swap
	// (0x2d720abb…, the topic DeFiLlama's bloom adapter reads), the 1 % fee
	// kept inside the router (Florent's test buy on Base, 2026-09-21: 0.001
	// ETH in, 0.00099 to the pool): the residual after the pool and gas.
	// Robinhood Chain 53 swaps an hour, BNB 4, Base 1, Ethereum none.
	{Slug: "bloom-robinhood", Name: "Bloom · Robinhood Chain", Kind: "bot", Chain: "robinhood", Routers: []string{"0xb1000000096bd2f8ca9b6883182eccaf31e7c3fd"}},
	{Slug: "bloom-bnb", Name: "Bloom · BNB", Kind: "bot", Chain: "bnb", Routers: []string{"0xb1000000096bd2f8ca9b6883182eccaf31e7c3fd"}},
	// Arc and HyperEVM (2026-09-21, the chains' logs searched by the routers'
	// own event topics): GMGN's routers there (the same swap-end events as
	// on BNB), BasedBot's router family (shared: filtered on its funded
	// wallets), Maestro's and Bloom's vanity routers.
	{Slug: "gmgn-arc", Name: "GMGN · Arc", Kind: "app", Chain: "arc", Routers: []string{"0x53dea4f7783c1de84cecc5c989bc37a557154827", "0x40fe100d34b6a552d49ad8cc252795ccead48277"}, Collector: "0xb8159ba378904f803639d274cec79f788931c9c8"},
	{Slug: "gmgn-hyperevm", Name: "GMGN · HyperEVM", Kind: "app", Chain: "hyperevm", Routers: []string{"0xfcacd2f51fc8fa0fe1ff3e781ce9f97584e62d99", "0x0556dd0302c2d4deaef4d76d0d3e2c3a0522a762"}, Collector: "0xb8159ba378904f803639d274cec79f788931c9c8"},
	{Slug: "basedbot-arc", Name: "BasedBot · Arc", Kind: "bot", Chain: "arc", Routers: []string{"0xd7d3181cff1fd948b4829cd2c16946f1fa13db20"}, FromSet: "basedbot",
		SenderTopic: map[string]int{"0x2ed5a8749a7e3a68a074750cc77850912a0708dc62ab7ea42b0c3e5beb36f017": 1},
		Note:        "BasedBot's users on Arc: the wallets on its Relay legs, trading on its router family's contract there (shared with other front ends: only those wallets' swaps count); the router's fee and referral transfers (about 1 %) are the fee, the residual after the pool and gas. Arc's gas is USDC."},
	{Slug: "basedbot-hyperevm", Name: "BasedBot · HyperEVM", Kind: "bot", Chain: "hyperevm", Routers: []string{"0x3aa9bcd8f955589baa29dd832d345d4bfe380ae9", "0x227be0f88ecb7899a0e6e0347888b909d622c8e1", "0x0f2730c4b0c279c8c7e3e5f9b7032eb7d42d06c0"}, FromSet: "basedbot",
		SenderTopic: map[string]int{"0x2ed5a8749a7e3a68a074750cc77850912a0708dc62ab7ea42b0c3e5beb36f017": 1},
		Note:        "BasedBot's users on HyperEVM: the wallets on its Relay legs, trading on its router family's contracts there (shared with other front ends: only those wallets' swaps count); the router's fee and referral transfers (about 1 %) are the fee, the residual after the pool and gas. HYPE priced from Hyperliquid's mids."},
	{Slug: "maestro-arc", Name: "Maestro · Arc", Kind: "bot", Chain: "arc", Routers: []string{"0x00000000e91fc5bad977c0cc4ad60557c06886a2"}, Collector: "0xb0999731f7c2581844658a9d2ced1be0077b7397"},
	{Slug: "maestro-hyperevm", Name: "Maestro · HyperEVM", Kind: "bot", Chain: "hyperevm", Routers: []string{"0x00000000e91fc5bad977c0cc4ad60557c06886a2"}, Collector: "0xb0999731f7c2581844658a9d2ced1be0077b7397"},
	{Slug: "bloom-arc", Name: "Bloom · Arc", Kind: "bot", Chain: "arc", Routers: []string{"0xb1000000096bd2f8ca9b6883182eccaf31e7c3fd"}},
	{Slug: "binance-wallet-bnb", Name: "Binance Wallet · BNB", Kind: "app", Chain: "bnb", Routers: []string{"0xb300000b72deaeb607a12d5f54773d1c19c7028d"}, NoEvents: true, DropLoops: true,
		Note: "Wallets trading the same token both ways four times or more in the window (farming loops) are left out of this row; the share left out is in the JSON."},
	{Slug: "binance-wallet-ethereum", Name: "Binance Wallet · Ethereum", Kind: "app", Chain: "ethereum", Routers: []string{"0xb300000b72deaeb607a12d5f54773d1c19c7028d"}, NoEvents: true, DropLoops: true,
		Note: "Wallets trading the same token both ways four times or more in the window (farming loops) are left out of this row; the share left out is in the JSON."},
	{Slug: "binance-wallet-base", Name: "Binance Wallet · Base", Kind: "app", Chain: "base", Routers: []string{"0xb300000b72deaeb607a12d5f54773d1c19c7028d"}, NoEvents: true, DropLoops: true,
		Note: "On Base most of the router's transactions are fee-free round trips on a few tokens (Binance Alpha-style volume, 0 to 1 bps terminal fee): wallets trading the same token both ways four times or more in the window are left out of this row, which keeps the retail swaps."},
}

const nativeNote = "Swaps routed through the terminal's own contracts on this chain, read from their events (successful swaps: a failed transaction emits none, so the fail rate comes from a sample of blocks read in full, every transaction sent to the routers counted, reverted or not). Value given = what the user sent plus gas; value received = the tokens at the pool's state before the swap (v2 reserves, v3 / v4 previous price). The terminal's fee is paid inside the router as a native transfer: it is the residual after the pool and the gas. A fee the pool's own hook keeps (launchpad pools on Robinhood Chain and BNB) is a pool cost; a fixed inclusion tip the terminal adds to every transaction is network cost."

// nativeFeed polls the routers' logs per chain since the last block seen.
type nativeFeed struct {
	http   *http.Client
	cursor map[string]int64 // chain -> last block scanned
	// The eth_getLogs range this chain's endpoint actually accepts. A
	// constant span cannot survive a provider that caps it: BNB's refused
	// every 400-block call ("up to a 10 block range"), the cursor only
	// advances on success, and it sat 623,045 blocks behind head for days
	// while six products published All chains rows without BNB.
	span   map[string]int64
	// Shared with State by reference, like the cursor: chain -> when its
	// feed last failed, so compute() can tell a chain it cannot read from
	// a chain nobody trades on.
	down   map[string]int64
	polled map[string][2]int64
	box    map[string]*xinboxTx
	up     map[string]bool
	funded map[string]map[string]int64 // State.Funded, set by sampleNative each tick (app -> wallet -> time)
}

// dropsLoops: whether the row leaves farming round trips out (DropLoops).
func dropsLoops(slug string) bool {
	for _, t := range evmTerminals {
		if t.Slug == slug {
			return t.DropLoops
		}
	}
	return false
}

// mine: whether a swap sent by `from` belongs to the terminal (always,
// unless the terminal reads a shared router through the app's funded set).
func (f *nativeFeed) mine(t evmTerminal, from string) bool {
	if t.FromSet == "" {
		return true
	}
	_, ok := f.funded[t.FromSet][strings.ToLower(from)]
	return ok
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
		termOf := map[string]evmTerminal{}
		for _, t := range evmTerminals {
			if t.Chain != c.slug {
				continue
			}
			for _, r := range t.Routers {
				byRouter[r] = t.Slug
			}
			noEvents[t.Slug] = t.NoEvents
			termOf[t.Slug] = t
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
		var loopSlugs []string
		for slug := range termOf {
			if dropsLoops(slug) {
				loopSlugs = append(loopSlugs, slug)
			}
		}
		loopers := loopersOf(st, loopSlugs) // farming wallets stay out of the attempts too, as they do of the loss sample
		for _, off := range rand.Perm(n)[:k] {
			bn := rng[0] + int64(off)
			var blk struct {
				Transactions []struct {
					Hash string `json:"hash"`
					From string `json:"from"`
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
				if slug == "" || !f.mine(termOf[slug], tx.From) || loopers[slug+":"+strings.ToLower(tx.From)] {
					continue
				}
				var rc evmReceipt
				if err := evmCall(ctx, f.http, c.rpc, "eth_getTransactionReceipt", []any{tx.Hash}, &rc); err != nil {
					continue
				}
				seen[slug]++
				if rc.Status != "0x1" {
					failed[slug]++
					if price > 0 { // no gas price this tick: the failure counts, its cost is not sampled
						fee := float64(hexInt(rc.GasUsed)) * float64(hexInt(rc.EffectiveGasPrice)) / 1e18 * price
						st.Fails = append(st.Fails, failSample{Terminal: slug, Sig: tx.Hash, Time: now, FeeUSD: fee, Err: "reverted"})
					}
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

// rangeRefusal: the endpoint refused the block range rather than failing
// for another reason. Providers word this differently, so match the words
// they share rather than one vendor's sentence.
func rangeRefusal(err error) bool {
	s := strings.ToLower(err.Error())
	if !strings.Contains(s, "block") && !strings.Contains(s, "range") {
		return false
	}
	for _, w := range []string{"range", "limit", "exceed", "too large", "up to", "max results", "free tier"} {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

func newNativeFeed(httpc *http.Client, cursor, down map[string]int64) *nativeFeed {
	if cursor == nil {
		cursor = map[string]int64{}
	}
	if down == nil {
		down = map[string]int64{}
	}
	return &nativeFeed{http: httpc, cursor: cursor, span: map[string]int64{}, down: down, polled: map[string][2]int64{}, box: map[string]*xinboxTx{}, up: map[string]bool{}}
}

// poll reads every router log since the cursor (at most 2,000 blocks a
// tick) and counts the distinct transactions per terminal.
func (f *nativeFeed) poll(ctx context.Context) {
	for _, c := range originChains {
		var routers []string
		byRouter := map[string]string{}
		termOf := map[string]evmTerminal{}
		for _, t := range evmTerminals {
			if t.Chain != c.slug {
				continue
			}
			for _, r := range t.Routers {
				routers = append(routers, r)
				byRouter[r] = t.Slug
			}
			termOf[t.Slug] = t
		}
		if len(routers) == 0 {
			continue
		}
		var headHex string
		if err := evmCall(ctx, f.http, c.rpc, "eth_blockNumber", []any{}, &headHex); err != nil {
			f.up[c.slug] = false
			if _, seen := f.down[c.slug]; !seen {
				f.down[c.slug] = time.Now().Unix()
			}
			gNativeUp.WithLabelValues(c.slug).Set(0)
			continue
		}
		head := hexInt(headHex)
		// Ranges of at most 400 blocks (50 on Ethereum, where the public
		// nodes cap eth_getLogs at 50 blocks; ten minutes of chain), a few
		// per tick: a public RPC may refuse or redirect a heavier query.
		span := f.span[c.slug]
		if span <= 0 {
			span = 400
			if c.slug == "ethereum" {
				span = 50
			}
		}
		// What one tick can actually read. The resume window used to be a
		// constant 200 blocks, which is far less than this and far less
		// than a fast chain produces between polls: Robinhood ran about
		// 3,000 blocks ahead every tick, so the "too far behind" branch
		// fired every time, jumped back to head-200, and about 93 % of the
		// chain was never read. cSkipped had been counting it all along.
		const maxChunks = 40
		budget := span * maxChunks
		from := f.cursor[c.slug] + 1
		skipped := int64(0)
		if from == 1 || head-from > budget {
			if from != 1 {
				log.Printf("[native] %s: cursor %d is %d blocks behind head %d, resuming from head-%d (the gap is not read nor sampled)", c.slug, from-1, head-from, head, budget)
				// Counted only if this poll then succeeds. A stuck cursor
				// would otherwise re-count the same gap on every tick and
				// bury the signal under an impossible number.
				skipped = head - budget - from
			}
			from = head - budget + 1 // first run, or too far behind: read as much as a tick can
		}
		if from > head {
			f.up[c.slug] = true
			continue
		}
		// Only as many calls as the gap in front of us needs.
		chunks := int((head-from)/span) + 1
		if chunks < 1 {
			chunks = 1
		}
		if chunks > maxChunks {
			chunks = maxChunks
		}
		start := from
		var logs []evmLog
		failed := false
		for chunk := 0; chunk < chunks && from <= head; chunk++ {
			to := from + span - 1
			if to > head {
				to = head
			}
			var part []evmLog
			err := evmCall(ctx, f.http, c.logsRPC(), "eth_getLogs", []any{map[string]any{"fromBlock": "0x" + big.NewInt(from).Text(16), "toBlock": "0x" + big.NewInt(to).Text(16), "address": routers}}, &part)
			if err != nil && strings.Contains(err.Error(), "empty result") {
				// No logs in that range is the right answer, not a failure:
				// the routers did not trade in those blocks. evmCall reports
				// a null RPC result as an error, and treating it as one
				// stalled the cursor, so a chain fell behind for being quiet
				// and the wider gap made the next window likelier to be
				// quiet too. Two other call sites already skip this.
				f.cursor[c.slug] = to
				from = to + 1
				continue
			}
			if err != nil {
				// A refusal about the range is the endpoint telling us its
				// cap. Shrink and let the next tick use it, rather than
				// repeat the same rejected call forever.
				// Straight to the floor, not by halves. Each refusal costs a
				// whole tick for that chain and the cursor restarts from
				// head-200, so quartering 400 down to 6 would burn four
				// ticks losing blocks the whole way. 10 is the cap the free
				// tiers publish; an endpoint that allows more only loses a
				// little throughput, an endpoint that allows less never
				// stalls us again.
				if span > 10 && rangeRefusal(err) {
					f.span[c.slug] = 10
					log.Printf("[native] %s getLogs %d-%d refused the %d-block range, dropping to %d: %v", c.slug, from, to, span, f.span[c.slug], err)
				} else {
					log.Printf("[native] %s getLogs %d-%d: %v", c.slug, from, to, err)
				}
				failed = true
				break
			}
			logs = append(logs, part...)
			f.cursor[c.slug] = to
			from = to + 1
		}
		f.up[c.slug] = !failed
		if failed {
			if _, seen := f.down[c.slug]; !seen {
				f.down[c.slug] = time.Now().Unix() // first failure of this outage
			}
		} else {
			delete(f.down, c.slug)
		}
		gNativeUp.WithLabelValues(c.slug).Set(map[bool]float64{true: 1}[!failed])
		gNativeLag.WithLabelValues(c.slug).Set(float64(head - f.cursor[c.slug]))
		if !failed && skipped > 0 {
			cSkipped.WithLabelValues(c.slug).Add(float64(skipped))
		}
		if f.cursor[c.slug] >= start {
			f.polled[c.slug] = [2]int64{start, f.cursor[c.slug]}
		} else {
			delete(f.polled, c.slug)
		}
		seen := map[string]bool{}
		others := map[string]int{} // shared routers: swaps by wallets outside the app's funded set
		for _, l := range logs {
			slug := byRouter[strings.ToLower(l.Address)]
			if slug == "" || seen[l.TxHash] || len(l.Topics) == 0 {
				continue
			}
			if t := termOf[slug]; t.FromSet != "" {
				// A shared router: only the events whose sender topic names a
				// wallet the app funded; other event kinds are not swaps here.
				idx, ok := t.SenderTopic[l.Topics[0]]
				if !ok || len(l.Topics) <= idx {
					continue
				}
				if !f.mine(t, topicAddr(l.Topics[idx])) {
					others[slug]++
					continue
				}
			}
			seen[l.TxHash] = true
			b := f.box[slug]
			if b == nil {
				b = &xinboxTx{}
				f.box[slug] = b
			}
			b.add(l.TxHash)
		}
		for slug, n := range others {
			if n > 0 {
				log.Printf("[native] %s: %d router swaps by wallets outside the funded set this tick (not counted)", slug, n)
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
// nativePollEvery: the EVM log feed polls every N ticks (the cursor
// keeps every block, a poll then covers N minutes of chain); 1 = each tick.
var nativePollEvery = 1
var nativeTick int

func sampleNative(ctx context.Context, httpc *http.Client, st *State, nf *nativeFeed, gas map[string]float64, quota map[string]float64, perTick float64) (added, seen int) {
	nf.funded = st.Funded
	nativeTick++
	if nativeTick%nativePollEvery != 0 {
		return 0, 0
	}
	nf.poll(ctx)
	now := time.Now().Unix()
	nf.failScan(ctx, st, gas, now)
	for _, t := range evmTerminals {
		n0, sample, total := nf.drain(t.Slug)
		seen += n0
		st.record(t.Slug, now, n0, 0, 0, nil)
		// The quota accrues every tick (a sparse row, one swap a minute,
		// would otherwise need several active ticks per sample); a poll
		// every N ticks accrues N ticks' worth.
		quota[t.Slug] += perTick * float64(nativePollEvery)
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
			if sw.Flag == "launch_first_trade" {
				st.reject(t.Slug, parseReject(sw.Flag)) // a token launch's first curve buy: no reference, not a user's fill
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
	// Transfers of a quote asset anywhere in the transaction, not only the
	// user's. A v4 swap that settles its quote natively or as an ERC-6909
	// claim emits none, and the pool leg is then not measurable from
	// transfers: see quoteMoves below.
	quoteMoves := 0
	for _, l := range rc.Logs {
		if len(l.Topics) != 3 || l.Topics[0] != topicTransfer {
			continue
		}
		erc, from, to, amt := strings.ToLower(l.Address), topicAddr(l.Topics[1]), topicAddr(l.Topics[2]), word(l.Data, 0)
		if m := erc20(ctx, httpc, *c, erc); m.ok {
			if _, isQuote := quoteUSD(m.symbol, *c, gas); isQuote {
				quoteMoves++
			}
		}
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
				// A mirror log of the native value is the same money as
				// tx.value, which the buy path adds separately. Counting
				// both doubled `given` on every Arc buy and pushed the
				// terminal fee, a residual, to about 5,047 bps.
				if hexBig(tx.Value).Sign() > 0 && isNativeMirror(c.slug, erc) {
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
		if tip := tipWei(); tip != nil && valueWei.Cmp(tip) >= 0 { // a buy paid in an ERC20 sends the tip alone as value
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
			sw.Flag = unpricedFlag(s.Unpriced)
			return sw
		}
		ref := s.MidUSD
		sw.finalize(&ref, 0, s.RefSrc)
		// The pool leg is read from transfers. On a v4 pool whose quote
		// settles natively or as an ERC-6909 claim there are none, so the
		// residual app fee carries the pool's take: BasedBot's Base rows
		// read 198.7 bps against a router that kept 100. Keep the row
		// visible and out of every figure rather than publish a split we
		// cannot measure.
		if sw.Priced && quoteMoves == 0 && strings.HasSuffix(sw.Venue, "-v4") {
			sw.Flag, sw.Priced = "unmeasured_quote_leg", false
		}
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
			sw.Flag = unpricedFlag(s.Unpriced)
			return sw
		}
		ref := s.MidUSD
		sw.finalize(&ref, 0, s.RefSrc)
		// The pool leg is read from transfers. On a v4 pool whose quote
		// settles natively or as an ERC-6909 claim there are none, so the
		// residual app fee carries the pool's take: BasedBot's Base rows
		// read 198.7 bps against a router that kept 100. Keep the row
		// visible and out of every figure rather than publish a split we
		// cannot measure.
		if sw.Priced && quoteMoves == 0 && strings.HasSuffix(sw.Venue, "-v4") {
			sw.Flag, sw.Priced = "unmeasured_quote_leg", false
		}
		implausibleSplit(sw)
		return sw
	}
	return &Swap{Flag: "unpriced_no_token_leg"}
}

// unpricedFlag: a settlement's reason as the row's flag; a token launch
// (the creator's first curve buy) is its own reject, not an unpriced fill.
func unpricedFlag(reason string) string {
	if reason == "launch" {
		return "launch_first_trade"
	}
	return "unpriced_" + reason
}
