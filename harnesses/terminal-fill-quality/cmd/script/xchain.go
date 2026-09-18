package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Cross-chain trades through Relay.
//
// FOMO (and BasedBot) let a user pay on BNB, Robinhood Chain, Base,
// Ethereum or Arc and receive a Solana token: the app quotes a Relay
// request with its fee attached (appFees to its own address), the user
// deposits on the origin chain, a Relay solver settles on Solana by
// buying the token and sending it to the user's wallet. Nothing on
// Solana pays the app's fee wallet, so the fee-wallet feed never sees
// these swaps; Relay's public requests API does, with what the user paid
// in USD, every fee (app, Relay, execution, and which of them the user
// actually paid after sponsorship), both transaction hashes and the
// status (success, refund, failure).
//
// Measurement: value given = the origin deposit in USD (Relay's figure,
// the amount the user sent) + the origin gas (receipt on the origin
// chain's public RPC); value received = the tokens delivered on Solana
// valued at the pool's state before the settlement swap, read from the
// Solana transaction exactly like a native swap (the recipient is the
// user, the solver is the payer). Components: terminal = app fee the
// user paid, relay = Relay's own fees the user paid, network = origin
// gas, pool = the rest (settlement impact and LP fee, Relay's spread).
//
// Requests whose Solana side delivers SOL or a stable (a sell from the
// origin chain) have no token leg on Solana and are not priced here.

type xchainApp struct {
	Slug          string
	Name          string
	FeeRecipients []string // app-fee recipients (EVM addresses, lower-case) that identify the app
	Referrer      string   // Relay referrer, when the app's requests are public under it
}

var xchainApps = []xchainApp{
	// FOMO's cross-chain fee address: the recipient of the 45 to 55 bps app
	// fee on the Relay requests settling to wallets that also trade FOMO
	// natively on Solana (join on Mobula's FOMO-attributed trades, 133 of
	// 2,000 settlements on 2026-09-18); FOMO's referrer is private (403).
	{Slug: "fomo-xchain", Name: "FOMO cross-chain", FeeRecipients: []string{"0x9fc4e320a181e88644a302d11f1f158ef0699e37"}},
	{Slug: "basedbot-xchain", Name: "BasedBot cross-chain", Referrer: "BasedBot"},
}

// Origin chains Relay users pay from, with a public RPC for the gas
// receipt and the gas token's Coinbase pair ("" = a $1 stable).
type originChain struct {
	id   int64
	slug string
	rpc  []string // public endpoints, tried in order (a receipt is one call)
	gas  string
}

var originChains = []originChain{
	{56, "bnb", []string{"https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org", "https://1rpc.io/bnb"}, "BNB-USD"},
	{4663, "robinhood", []string{"https://rpc.mainnet.chain.robinhood.com"}, "ETH-USD"},
	{8453, "base", []string{"https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"}, "ETH-USD"},
	{1, "ethereum", []string{"https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"}, "ETH-USD"},
	{5042, "arc", []string{"https://rpc.mainnet.arc.io"}, ""},
}

const solanaChainID = 792703809

// relayRequest is one settled (or failed) Relay request of a cohort app.
type relayRequest struct {
	ID          string  `json:"id"`
	App         string  `json:"app"`
	Chain       string  `json:"chain"` // origin chain slug
	Status      string  `json:"status"`
	User        string  `json:"user"`      // origin address
	Recipient   string  `json:"recipient"` // Solana wallet
	InTx        string  `json:"in_tx"`
	OutTx       string  `json:"out_tx"` // Solana signature
	UsdIn       float64 `json:"usd_in"`
	UsdOut      float64 `json:"usd_out"` // Relay's own valuation of the output, cross-check only
	AppFeeUsd   float64 `json:"app_fee_usd"`
	RelayFeeUsd float64 `json:"relay_fee_usd"`
	OutIsToken  bool    `json:"out_is_token"` // Solana side delivers a token (not SOL / a stable)
	InIsToken   bool    `json:"in_is_token"`  // origin side was a token (not the gas coin / a stable): usd_in is Relay's valuation, not an on-chain mid
	Created     int64   `json:"created"`
}

type relayResp struct {
	Requests     []json.RawMessage `json:"requests"`
	Continuation string            `json:"continuation"`
}

type relayRaw struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	User      string `json:"user"`
	Recipient string `json:"recipient"`
	CreatedAt string `json:"createdAt"`
	Data      struct {
		Referrer string `json:"referrer"`
		AppFees  []struct {
			Recipient string `json:"recipient"`
			Bps       string `json:"bps"`
			AmountUsd string `json:"amountUsd"`
		} `json:"appFees"`
		InTxs    []relayTx `json:"inTxs"`
		OutTxs   []relayTx `json:"outTxs"`
		Metadata struct {
			CurrencyIn  relayAmount `json:"currencyIn"`
			CurrencyOut relayAmount `json:"currencyOut"`
		} `json:"metadata"`
		FeeSponsorship struct {
			Quoted struct {
				Components map[string]struct {
					Total struct {
						AmountUsd string `json:"amountUsd"`
					} `json:"total"`
					UserPays struct {
						AmountUsd string `json:"amountUsd"`
					} `json:"userPays"`
				} `json:"components"`
			} `json:"quoted"`
		} `json:"feeSponsorship"`
	} `json:"data"`
}

type relayTx struct {
	ChainID int64  `json:"chainId"`
	Hash    string `json:"hash"`
}

type relayAmount struct {
	Currency struct {
		ChainID int64  `json:"chainId"`
		Address string `json:"address"`
		Symbol  string `json:"symbol"`
	} `json:"currency"`
	AmountUsd string `json:"amountUsd"`
}

func f64(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }

// xfeed polls Relay's public requests feed per origin chain and keeps,
// per app and per tick, the counts and a reservoir of successful
// settlements on Solana, like the WebSocket feed does for native swaps.
type xfeed struct {
	http *http.Client
	mu   sync.Mutex
	seen map[string]int64 // request id -> first seen (dedupe across polls)
	box  map[string]*xinbox
	ok   map[string]int
	last time.Time
	up   bool
}

type xinbox struct {
	seen, failed int
	errs         map[string]int
	reservoir    []relayRequest
	total        int
}

func newXfeed(httpc *http.Client) *xfeed {
	f := &xfeed{http: httpc, seen: map[string]int64{}, box: map[string]*xinbox{}, ok: map[string]int{}}
	for _, a := range xchainApps {
		f.box[a.Slug] = &xinbox{}
	}
	return f
}

// run polls every interval. Each poll walks each origin chain's feed
// (newest first, 50 per page) until it meets a request already seen or
// runs out of pages; every new request of a cohort app is counted and,
// when it settled a token on Solana, offered to the reservoir.
func (f *xfeed) run(ctx context.Context, interval time.Duration) {
	for ctx.Err() == nil {
		n := 0
		for _, c := range originChains {
			n += f.poll(ctx, c)
		}
		f.mu.Lock()
		f.up = true
		f.last = time.Now()
		// forget ids older than a day
		cut := time.Now().Add(-24 * time.Hour).Unix()
		for id, t := range f.seen {
			if t < cut {
				delete(f.seen, id)
			}
		}
		f.mu.Unlock()
		if n > 0 {
			log.Printf("[relay] %d new requests", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func (f *xfeed) poll(ctx context.Context, c originChain) int {
	added := 0
	for _, a := range xchainApps {
		if a.Referrer == "" && len(a.FeeRecipients) == 0 {
			continue
		}
		cont := ""
		for page := 0; page < 6; page++ {
			url := fmt.Sprintf("https://api.relay.link/requests/v2?originChainId=%d&limit=50", c.id)
			if a.Referrer != "" {
				url += "&referrer=" + a.Referrer
			}
			if cont != "" {
				url += "&continuation=" + cont
			}
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			req.Header.Set("User-Agent", "Mozilla/5.0 OpenChainBench/1.0 (+https://openchainbench.com)")
			req.Header.Set("Accept", "application/json")
			resp, err := f.http.Do(req)
			if err != nil {
				return added
			}
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
			resp.Body.Close()
			if resp.StatusCode != 200 {
				return added
			}
			var rr relayResp
			if json.Unmarshal(body, &rr) != nil {
				return added
			}
			stop := len(rr.Requests) == 0
			for _, raw := range rr.Requests {
				var r relayRaw
				if json.Unmarshal(raw, &r) != nil || r.ID == "" {
					continue
				}
				f.mu.Lock()
				_, known := f.seen[r.ID]
				f.mu.Unlock()
				if known {
					stop = true
					continue
				}
				if r.Status == "pending" || r.Status == "depositing" {
					continue // not final yet; seen on a later poll
				}
				x, ok := classify(a, c, r)
				f.mu.Lock()
				f.seen[r.ID] = time.Now().Unix()
				if ok {
					b := f.box[a.Slug]
					b.seen++
					if x.Status != "success" {
						b.failed++
						if b.errs == nil {
							b.errs = map[string]int{}
						}
						b.errs[x.Status]++
					} else if x.OutTx != "" {
						b.total++
						if len(b.reservoir) < reservoirSize {
							b.reservoir = append(b.reservoir, x)
						} else if j := rand.Intn(b.total); j < reservoirSize {
							b.reservoir[j] = x
						}
					}
					added++
				}
				f.mu.Unlock()
			}
			cont = rr.Continuation
			if stop || cont == "" {
				break
			}
		}
	}
	return added
}

// classify decides whether a Relay request belongs to the app (its fee
// recipient or referrer) and reduces it to the figures the bench needs.
func classify(a xchainApp, c originChain, r relayRaw) (relayRequest, bool) {
	mine := a.Referrer != "" && r.Data.Referrer == a.Referrer
	appFee := 0.0
	for _, fee := range r.Data.AppFees {
		rec := strings.ToLower(fee.Recipient)
		for _, want := range a.FeeRecipients {
			if rec == want {
				mine = true
			}
		}
		appFee += f64(fee.AmountUsd)
	}
	if a.Referrer != "" {
		mine = true // the feed itself was filtered on the referrer
	}
	if !mine {
		return relayRequest{}, false
	}
	x := relayRequest{ID: r.ID, App: a.Slug, Chain: c.slug, Status: r.Status, User: r.User, Recipient: r.Recipient, UsdIn: f64(r.Data.Metadata.CurrencyIn.AmountUsd), UsdOut: f64(r.Data.Metadata.CurrencyOut.AmountUsd)}
	if t, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err == nil {
		x.Created = t.Unix()
	}
	for _, tx := range r.Data.InTxs {
		if tx.Hash != "" {
			x.InTx = tx.Hash
			break
		}
	}
	for _, tx := range r.Data.OutTxs {
		if tx.ChainID == solanaChainID && tx.Hash != "" {
			x.OutTx = tx.Hash
			break
		}
	}
	out := r.Data.Metadata.CurrencyOut.Currency
	x.OutIsToken = out.ChainID == solanaChainID && out.Address != "" && out.Address != "11111111111111111111111111111111" && out.Address != wsolMint && !stableMints[out.Address]
	in := r.Data.Metadata.CurrencyIn.Currency
	switch strings.ToUpper(in.Symbol) {
	case "ETH", "BNB", "WETH", "WBNB", "USDC", "USDT", "USDG", "USD1", "DAI", "USDS", "USDE", "PYUSD", "USDC.E", "USDBC", "SOL":
		x.InIsToken = false
	default:
		x.InIsToken = in.Address != "0x0000000000000000000000000000000000000000"
	}
	// What the user actually paid after Relay's sponsorship: the app's
	// fee and Relay's own components (execution on the destination, the
	// swap, the relay service, rent). When the quote carries no
	// sponsorship breakdown, the app fee is the quoted one.
	comps := r.Data.FeeSponsorship.Quoted.Components
	if len(comps) > 0 {
		if app, ok := comps["app"]; ok {
			x.AppFeeUsd = f64(app.UserPays.AmountUsd)
		} else {
			x.AppFeeUsd = appFee
		}
		for _, k := range []string{"execution", "swap", "relay", "rent"} {
			if v, ok := comps[k]; ok {
				x.RelayFeeUsd += f64(v.UserPays.AmountUsd)
			}
		}
	} else {
		x.AppFeeUsd = appFee
	}
	return x, true
}

func (f *xfeed) drain(slug string) (seen, failed int, errs map[string]int, sample []relayRequest, total int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b := f.box[slug]
	if b == nil {
		return
	}
	seen, failed, errs, sample, total = b.seen, b.failed, b.errs, b.reservoir, b.total
	f.box[slug] = &xinbox{}
	f.ok[slug] = total
	return
}

func (f *xfeed) healthy() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.up && time.Since(f.last) < 5*time.Minute
}

// bridgeRow reduces a settlement that delivered SOL or a stable to the
// user (a funding leg) to a Swap: Tokens = the quote received, valued 1:1,
// UserQ = the origin deposit plus its gas, terminal = the app fee, relay =
// what Relay kept (deposit − received − app fee: its fees and its
// spread), network = origin gas. Nil when the user received nothing.
func bridgeRow(t Terminal, x relayRequest, tx *parsedTx, solUSD, gasUSD float64) *Swap {
	msg := tx.Transaction.Message
	n := len(msg.AccountKeys)
	if n == 0 || len(tx.Meta.PreBalances) != n || len(tx.Meta.PostBalances) != n {
		return nil
	}
	// Stable received on token accounts owned by the user, SOL received
	// on the user's own account; the larger of the two in USD is the
	// delivered asset.
	stable := map[string]float64{}
	pre := map[int]float64{}
	for _, b := range tx.Meta.PreTokenBalances {
		if b.Owner == x.Recipient && stableMints[b.Mint] {
			pre[b.AccountIndex] = b.raw() * 1e-6
		}
	}
	for _, b := range tx.Meta.PostTokenBalances {
		if b.Owner == x.Recipient && stableMints[b.Mint] {
			d := b.raw()*1e-6 - pre[b.AccountIndex]
			if d > 0 {
				stable[quoteName(b.Mint)] += d
			}
		}
	}
	sol := 0.0
	for i, k := range msg.AccountKeys {
		if k.Pubkey == x.Recipient {
			sol += float64(int64(tx.Meta.PostBalances[i])-int64(tx.Meta.PreBalances[i])) / 1e9
		}
	}
	quote, recv, q := "", 0.0, 0.0
	for name, v := range stable {
		if v > recv {
			quote, recv, q = name, v, 1
		}
	}
	if sol*solUSD > recv*q {
		quote, recv, q = "SOL", sol, solUSD
	}
	if recv <= 0 || q <= 0 {
		return nil
	}
	sw := &Swap{Method: methodVersion, Sig: x.OutTx, Terminal: t.Slug, Slot: tx.Slot, User: x.Recipient, Side: "buy", Quote: quote, Venue: "relay", Mint: quote, Tokens: recv, QuoteUSD: q, Pools: 0}
	if tx.BlockTime != nil {
		sw.Time = *tx.BlockTime
	}
	sw.UserQ = (x.UsdIn + gasUSD) / q
	sw.TerminalQ = x.AppFeeUsd / q
	sw.NetworkQ = gasUSD / q
	relay := x.UsdIn - recv*q - x.AppFeeUsd
	if relay < 0 {
		relay = 0
	}
	sw.RelayQ = relay / q
	sw.PoolQ = recv
	zero := 0.0
	sw.OtherQ = &zero
	return sw
}

// originGasUSD reads the origin deposit's receipt on the chain's public
// RPC: gasUsed × effectiveGasPrice in the gas token, priced in USD.
func originGasUSD(ctx context.Context, httpc *http.Client, chain string, hash string, gasUSD map[string]float64) (float64, bool) {
	var c *originChain
	for i := range originChains {
		if originChains[i].slug == chain {
			c = &originChains[i]
		}
	}
	if c == nil || hash == "" {
		return 0, false
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionReceipt", "params": []any{hash}})
	var out struct {
		Result *struct {
			GasUsed           string `json:"gasUsed"`
			EffectiveGasPrice string `json:"effectiveGasPrice"`
		} `json:"result"`
	}
	for _, url := range c.rpc {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 OpenChainBench/1.0")
		resp, err := httpc.Do(req)
		if err != nil {
			continue
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out)
		resp.Body.Close()
		if err == nil && out.Result != nil {
			break
		}
		out.Result = nil
	}
	if out.Result == nil {
		return 0, false
	}
	used, err1 := strconv.ParseUint(strings.TrimPrefix(out.Result.GasUsed, "0x"), 16, 64)
	price, err2 := strconv.ParseUint(strings.TrimPrefix(out.Result.EffectiveGasPrice, "0x"), 16, 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	native := float64(used) * float64(price) / 1e18
	if c.gas == "" {
		return native, true // a $1 stable gas token (Arc: USDC, 6 decimals handled by the chain as 18? keep native)
	}
	p, ok := gasUSD[c.gas]
	if !ok || p <= 0 {
		return 0, false
	}
	return native * p, true
}

// gasPrices reads the origin gas tokens' USD prices from Coinbase spot.
func gasPrices(ctx context.Context, httpc *http.Client) map[string]float64 {
	out := map[string]float64{}
	for _, pair := range []string{"ETH-USD", "BNB-USD"} {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.coinbase.com/v2/prices/"+pair+"/spot", nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
		resp, err := httpc.Do(req)
		if err != nil {
			continue
		}
		var cb struct {
			Data struct {
				Amount string `json:"amount"`
			} `json:"data"`
		}
		json.NewDecoder(resp.Body).Decode(&cb)
		resp.Body.Close()
		if p := f64(cb.Data.Amount); p > 0 {
			out[pair] = p
		}
	}
	return out
}
