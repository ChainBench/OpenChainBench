package main

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
)

// Swap is one sampled, successfully executed swap routed through a
// terminal, reduced to what the user paid and what they got.
//
// Quote-side amounts are exact, from the balance deltas of the
// transaction, in quote units (SOL or a $1 stable):
//
//	UserQ     what left (buy) or reached (sell) the user's quote balance,
//	          rent of accounts created or closed in the tx excluded; the
//	          tx fee is inside when the user paid it
//	PoolQ     what the pool(s) received (buy) or paid out (sell)
//	TerminalQ what landed in the terminal's fee wallets (and, for FOMO,
//	          its user-signed stable fee legs)
//	NetworkQ  tx fee (paid by the user, or by the terminal's sponsor out of
//	          its fee: then moved from terminal to network) +
//	          inclusion tips (Jito and the other relays, the terminal's own) +
//	          the deposit of the token accounts the swap created (rent)
//	OtherQ    quote that left the user and reached neither the final pool,
//	          the terminal nor the network: UserQ − PoolQ − TerminalQ − NetworkQ
//	          (pump.fun protocol / creator fees, referrals; on routed swaps
//	          the routers' cuts and the hops' leftovers); nil when a routed
//	          swap's residual exceeds a quarter of the trade (route not followed)
//
// The token leg (Tokens of Mint) is valued at the pool's own state before
// the swap (reserves, or the previous trade on the pool), see finalize:
//
//	buy : loss = 1 − Tokens × ref / UserQ
//	sell: loss = 1 − UserQ / (Tokens × ref)
type Swap struct {
	Method   int    `json:"method"` // methodVersion that produced the row
	Sig      string `json:"sig"`
	Terminal string `json:"terminal"`
	// The pooled row this swap rolls up to, when that is not the terminal
	// itself: Binance's swaps are stored under binance-wallet-base and
	// binance-wallet-ethereum, so the Binance row could not find them.
	// Set at publish time only, so the state file keeps its old shape.
	Product string  `json:"product,omitempty"`
	Slot    uint64  `json:"slot"`
	Time    int64   `json:"time"`
	User    string  `json:"user"`
	Side    string  `json:"side"`  // buy | sell
	Quote   string  `json:"quote"` // SOL | USDC | USDT | USD1
	Venue   string  `json:"venue"`
	Mint    string  `json:"mint"`
	Tokens  float64 `json:"tokens"`

	// Pool identity for the reference-price lookups and the sandwich
	// screen: the pool's token vault for the traded mint, its owner (pool
	// PDA / AMM authority / curve account) and its quote-side vaults, all
	// by pubkey, taken from the swap instruction's own account list so two
	// pools behind one shared authority (Raydium, Launchpad, DAMM v2)
	// never merge. Pools counts the token counterparties (split routes),
	// Hops the pool instructions of the route that are not on the token.
	PoolVault       string   `json:"pool_vault,omitempty"`
	PoolOwner       string   `json:"pool_owner,omitempty"`
	PoolQuoteVaults []string `json:"pool_quote_vaults,omitempty"`
	Pools           int      `json:"pools"`
	Hops            int      `json:"hops,omitempty"`
	// Pre-trade balances when the route is one constant-product pool
	// (PumpSwap, Raydium v4 / CPMM): token vault in tokens, quote vault in
	// quote units. Zero otherwise.
	PoolBasePre  float64 `json:"pool_base_pre,omitempty"`
	PoolQuotePre float64 `json:"pool_quote_pre,omitempty"`
	// Routes whose final pool is quoted in a third asset (FOMO: USDC →
	// NEAR / INJ / USO → token): the asset and its rate in quote units,
	// read from the route's own hop in the same transaction.
	XMint string  `json:"x_mint,omitempty"`
	XRate float64 `json:"x_rate,omitempty"` // quote units per X

	UserQ     float64  `json:"user_q"`
	PoolQ     float64  `json:"pool_q"`
	TerminalQ float64  `json:"terminal_q"`
	NetworkQ  float64  `json:"network_q"`
	OtherQ    *float64 `json:"other_q,omitempty"`
	// Cross-chain settlements (see xchain.go): the origin chain, Relay's
	// own fees the user paid (quote units), the Relay request id and the
	// origin deposit hash. UserQ is then the origin deposit in quote units,
	// NetworkQ the origin gas.
	Chain    string  `json:"chain,omitempty"`
	RelayQ   float64 `json:"relay_q,omitempty"`
	FeeSig   string  `json:"fee_sig,omitempty"` // the separate fee transaction (BasedBot on Solana)
	RentQ    float64 `json:"rent_q,omitempty"`  // SOL deposit of the token accounts the swap created: counted in network (a refund on close is not credited)
	RelayID  string  `json:"relay_id,omitempty"`
	// The Relay request carried no fee of any kind. RelayQ is then 0
	// because we were not told, not because the solver took nothing, and a
	// residual pool component would silently absorb the bridge's take.
	RelayUnknown bool `json:"relay_unknown,omitempty"`
	InTx     string  `json:"in_tx,omitempty"`
	QuoteUSD float64 `json:"quote_usd"` // quote unit price used for sizing
	// Quote received by accounts that are neither user, pool, terminal nor
	// tip, by pubkey (token accounts keyed by owner): what "other" is made
	// of, aggregated per terminal for audit.
	Others map[string]float64 `json:"others,omitempty"`

	// Set by finalize: reference price of the token (quote units per
	// token), where it came from ("reserves": exact pre-trade mid, "pool":
	// previous trade on the same pool) and the derived figures. Flag marks
	// a row kept out of the statistics (loss outside the plausible bounds).
	RefPrice *float64 `json:"ref_price,omitempty"`
	RefSrc   string   `json:"ref_src,omitempty"`
	RefAgeS  *int64   `json:"ref_age_s,omitempty"`
	Priced   bool     `json:"priced"`
	Flag     string   `json:"flag,omitempty"`
	TradeUSD float64  `json:"trade_usd"` // buy: quote spent; sell: tokens × ref; plus the gas paid in another asset (quote moved when unpriced)
	// Neighbourhood scan for a sandwich around this swap (see sandwich.go).
	Scanned      bool      `json:"scanned"`
	BlockPoolTxs int       `json:"block_pool_txs,omitempty"`
	Sandwich     *Sandwich `json:"sandwich,omitempty"`
	// Basis points of the trade.
	LossBps     *float64 `json:"loss_bps,omitempty"`
	PoolBps     *float64 `json:"pool_bps,omitempty"`
	TerminalBps float64  `json:"terminal_bps"`
	NetworkBps  float64  `json:"network_bps"`
	RelayBps    float64  `json:"relay_bps,omitempty"`
	OtherBps    *float64 `json:"other_bps,omitempty"`
}

// Plausible loss bounds, basis points: a swap can gain a little against
// a reference that sits one trade earlier, and lose most of its value on
// a rug or a thin pool; beyond these the row is a parsing or reference
// error and stays out of the statistics (kept in the JSON, flagged).
const (
	lossMinBps = -1000
	lossMaxBps = 5000
)

// parseReject explains why a transaction touching a fee wallet is not a
// swap we can measure; counted per terminal for the coverage figures.
type parseReject string

const (
	rejectNotSwap    parseReject = "not_swap"    // no user token leg (wallet funding, fee sweep…)
	rejectTokenSwap  parseReject = "token_token" // neither side is SOL or a stable
	rejectNoPool     parseReject = "no_pool"     // could not identify the counterparty
	rejectDegenerate parseReject = "degenerate"  // zero or negative amounts
	rejectDust       parseReject = "dust"        // under MIN_TRADE_USD, basis points are noise
	rejectUnparsed   parseReject = "unparsed"    // a balance the RPC returned is not a number
)

// minTradeUSD: swaps below it are not measured (fixed fees dwarf the
// trade and a few cents of price move read as thousands of bps).
var minTradeUSD = 2.0

type tokenAcct struct {
	owner, mint string
	dec         int
	pre, post   float64 // raw units
	hadPre      bool
}

func (e *tokenAcct) delta() float64 { return (e.post - e.pre) * math.Pow10(-e.dec) }

// parseSwap reduces a jsonParsed transaction to a Swap (unpriced).
// forceUser names the user when the transaction does not (a Relay
// settlement: the solver signs and pays, the recipient gets the tokens).
func parseSwap(t Terminal, sig string, tx *parsedTx, solUSD float64, forceUser string) (*Swap, parseReject) {
	msg := tx.Transaction.Message
	n := len(msg.AccountKeys)
	if n == 0 || len(tx.Meta.PreBalances) != n || len(tx.Meta.PostBalances) != n {
		return nil, rejectNotSwap
	}
	fee := set(t.Wallets...)
	internal := set(t.Internal...)
	ownTips := set(t.Tips...)
	tip := func(k string) bool { return ownTips[k] || isTip(k) }
	pubkeyAt := func(i int) string { return msg.AccountKeys[i].Pubkey }
	index := make(map[string]int, n)
	for i := 0; i < n; i++ {
		index[pubkeyAt(i)] = i
	}

	// Lamport deltas per pubkey.
	lam := make(map[string]int64, n)
	for i := 0; i < n; i++ {
		lam[pubkeyAt(i)] += int64(tx.Meta.PostBalances[i]) - int64(tx.Meta.PreBalances[i])
	}

	// Token balances per account index.
	tok := map[int]*tokenAcct{}
	for _, b := range tx.Meta.PreTokenBalances {
		v := b.raw()
		if math.IsNaN(v) {
			return nil, rejectUnparsed
		}
		tok[b.AccountIndex] = &tokenAcct{owner: b.Owner, mint: b.Mint, dec: b.UITokenAmount.Decimals, pre: v, hadPre: true}
	}
	for _, b := range tx.Meta.PostTokenBalances {
		v := b.raw()
		if math.IsNaN(v) {
			return nil, rejectUnparsed
		}
		e, ok := tok[b.AccountIndex]
		if !ok {
			e = &tokenAcct{owner: b.Owner, mint: b.Mint, dec: b.UITokenAmount.Decimals}
			tok[b.AccountIndex] = e
		}
		if e.owner == "" {
			e.owner = b.Owner
		}
		e.post = v
	}
	isQuoteMint := func(m string) bool { return m == wsolMint || stableMints[m] }

	// Instructions, top-level then inner: the pool instructions (venue
	// program with its account list), the system instructions that create
	// accounts (rent), and the token transfers the user signed.
	var ixs []instruction
	ixs = append(ixs, msg.Instructions...)
	for _, in := range tx.Meta.InnerInstructions {
		ixs = append(ixs, in.Instructions...)
	}
	type venueIx struct {
		venue string
		accts map[string]bool
	}
	var vixs []venueIx               // known venue programs: pool identity
	var hixs []venueIx               // every program instruction with an account list: hop detection (venue "" when unknown)
	rentAccts := map[string]string{} // created account -> funder ("" when unknown)
	type tokTransfer struct {
		authority, dest string
		amount          float64 // raw units
	}
	var transfers []tokTransfer
	for _, ix := range ixs {
		if v, ok := venuePrograms[ix.ProgramID]; ok && v.name != "jupiter" {
			a := make(map[string]bool, len(ix.Accounts))
			for _, k := range ix.Accounts {
				a[k] = true
			}
			vixs = append(vixs, venueIx{v.name, a})
			hixs = append(hixs, venueIx{v.name, a})
			continue
		}
		if len(ix.Parsed) == 0 {
			if len(ix.Accounts) > 0 {
				a := make(map[string]bool, len(ix.Accounts))
				for _, k := range ix.Accounts {
					a[k] = true
				}
				hixs = append(hixs, venueIx{"", a})
			}
			continue
		}
		var p struct {
			Type string         `json:"type"`
			Info map[string]any `json:"info"`
		}
		if json.Unmarshal(ix.Parsed, &p) != nil {
			continue
		}
		str := func(k string) string { s, _ := p.Info[k].(string); return s }
		switch ix.Program {
		case "system":
			switch p.Type {
			case "createAccount", "createAccountWithSeed":
				rentAccts[str("newAccount")] = str("source")
			case "allocate":
				if _, ok := rentAccts[str("account")]; !ok {
					rentAccts[str("account")] = ""
				}
			}
		case "spl-token", "spl-token-2022":
			if p.Type == "transfer" || p.Type == "transferChecked" {
				amt := 0.0
				if s := str("amount"); s != "" {
					amt, _ = strconv.ParseFloat(s, 64)
				} else if ta, ok := p.Info["tokenAmount"].(map[string]any); ok {
					if s, ok := ta["amount"].(string); ok {
						amt, _ = strconv.ParseFloat(s, 64)
					}
				}
				transfers = append(transfers, tokTransfer{str("authority"), str("destination"), amt})
			}
		}
	}

	// The user: the signer with the largest non-quote token move, excluding
	// the terminal's own accounts.
	type userCand struct {
		pubkey string
		mint   string
		dec    int
		delta  float64 // raw units
		mints  int
	}
	var best *userCand
	signers := msg.AccountKeys
	if forceUser != "" {
		// The named wallet, whether it signed or not (its token account is
		// enough): pretend it is the only signer.
		signers = []struct {
			Pubkey string `json:"pubkey"`
			Signer bool   `json:"signer"`
		}{{Pubkey: forceUser, Signer: true}}
	}
	for _, k := range signers {
		if !k.Signer || fee[k.Pubkey] || internal[k.Pubkey] {
			continue
		}
		perMint := map[string]*userCand{}
		for _, e := range tok {
			if e.owner != k.Pubkey || isQuoteMint(e.mint) {
				continue
			}
			d := e.post - e.pre
			if d == 0 {
				continue
			}
			c, ok := perMint[e.mint]
			if !ok {
				c = &userCand{pubkey: k.Pubkey, mint: e.mint, dec: e.dec}
				perMint[e.mint] = c
			}
			c.delta += d
		}
		for _, c := range perMint {
			if math.Abs(c.delta) < 1 {
				continue
			}
			c.mints = len(perMint)
			if best == nil || math.Abs(c.delta)*math.Pow10(-c.dec) > math.Abs(best.delta)*math.Pow10(-best.dec) {
				best = c
			}
		}
	}
	if best == nil && forceUser == "" {
		// Nobody signed for the user: a keeper-executed order (limit, DCA,
		// auto-sell) where the terminal's keeper signs and the user's token
		// account moves. The user is then the wallet (on-curve owner, not a
		// program-derived pool address) with the largest non-quote token
		// move, whose quote side moved the other way.
		perOwner := map[string]*userCand{}
		for _, e := range tok {
			if isQuoteMint(e.mint) || e.owner == "" || fee[e.owner] || internal[e.owner] || tip(e.owner) {
				continue
			}
			d := e.post - e.pre
			if d == 0 || !onCurve(e.owner) {
				continue
			}
			c, ok := perOwner[e.owner]
			if !ok {
				c = &userCand{pubkey: e.owner, mint: e.mint, dec: e.dec}
				perOwner[e.owner] = c
			}
			if e.mint != c.mint {
				c.mints = 2
				continue
			}
			c.delta += d
		}
		for _, c := range perOwner {
			if math.Abs(c.delta) < 1 || c.mints > 1 {
				continue
			}
			// Quote moved against the token leg for this wallet?
			q := float64(lam[c.pubkey])
			for _, e := range tok {
				if e.owner == c.pubkey && isQuoteMint(e.mint) {
					q += e.post - e.pre
				}
			}
			if q == 0 || (q > 0) == (c.delta > 0) {
				continue
			}
			if best == nil || math.Abs(c.delta)*math.Pow10(-c.dec) > math.Abs(best.delta)*math.Pow10(-best.dec) {
				best = c
			}
		}
	}
	if best == nil {
		return nil, rejectNotSwap
	}
	if best.mints > 1 {
		return nil, rejectTokenSwap
	}
	user := best.pubkey
	side := "buy"
	if best.delta < 0 {
		side = "sell"
	}

	// Rent: token accounts created in this tx (their lamports left the
	// user but are not part of the swap; a WSOL account also holds the
	// wrapped amount, which the token delta already carries) or closed
	// (rent came back); program accounts the user funded (pump.fun's
	// per-user volume accumulator on a first trade).
	rent := 0.0
	rentPaid := map[string]bool{}
	for i, e := range tok {
		if e.owner != user {
			continue
		}
		wsolPre, wsolPost := 0.0, 0.0
		if e.mint == wsolMint {
			wsolPre, wsolPost = e.pre*math.Pow10(-e.dec), e.post*math.Pow10(-e.dec)
		}
		if !e.hadPre && tx.Meta.PostBalances[i] > tx.Meta.PreBalances[i] {
			rent += float64(tx.Meta.PostBalances[i]-tx.Meta.PreBalances[i])/1e9 - wsolPost
		}
		if e.hadPre && tx.Meta.PostBalances[i] == 0 && tx.Meta.PreBalances[i] > 0 {
			rent -= float64(tx.Meta.PreBalances[i])/1e9 - wsolPre
		}
	}
	for k, src := range rentAccts {
		i, ok := index[k]
		if !ok {
			continue
		}
		if _, isTok := tok[i]; isTok {
			continue
		}
		if src != user && !(src == "" && pubkeyAt(0) == user) {
			continue
		}
		if tx.Meta.PreBalances[i] == 0 && lam[k] > 0 {
			rent += float64(lam[k]) / 1e9
			rentPaid[k] = true
		}
	}

	// User's quote movements: lamports + WSOL (SOL), and each stable. The
	// tx fee stays inside: it is part of what the swap cost.
	quoteDelta := map[string]float64{}
	// A deposit paid for a new token account is network cost (Sacha,
	// 2026-09-21: "rent is part of network fees"): it stays in what the
	// user gave and joins the tx fee below. A refund on close is not
	// credited (added back here), so a round trip reads the deposit once.
	rentPaidQ := 0.0
	if rent > 0 {
		rentPaidQ = rent
		quoteDelta["SOL"] = float64(lam[user]) / 1e9
	} else {
		quoteDelta["SOL"] = float64(lam[user])/1e9 + rent
	}
	for _, e := range tok {
		if e.owner != user {
			continue
		}
		if e.mint == wsolMint {
			quoteDelta["SOL"] += e.delta()
		} else if stableMints[e.mint] {
			quoteDelta[quoteName(e.mint)] += e.delta()
		}
	}
	// Network cost: tx fee when the user is the fee payer (account 0), plus
	// inclusion tips. When the terminal's own account pays the fee (FOMO's
	// sponsor), the fee is still network cost, funded out of the terminal's
	// take: it is moved from terminal to network below.
	network := 0.0
	sponsoredFee := 0.0
	if pubkeyAt(0) == user {
		network += float64(tx.Meta.Fee) / 1e9
	} else if internal[pubkeyAt(0)] {
		sponsoredFee = float64(tx.Meta.Fee) / 1e9
		network += sponsoredFee
	}
	for k, v := range lam {
		if tip(k) && v > 0 {
			network += float64(v) / 1e9
		}
	}

	// Quote asset: the one that moved the most, in USD.
	quote := ""
	quoteMove := 0.0
	for name, d := range quoteDelta {
		usd := math.Abs(d)
		if name == "SOL" {
			usd *= solUSD
		}
		if usd > quoteMove {
			quoteMove = usd
			quote = name
		}
	}
	if quote == "" || quoteMove < 0.01 {
		return nil, rejectTokenSwap
	}
	quoteUSD := 1.0
	if quote == "SOL" {
		quoteUSD = solUSD
	}
	toQuote := func(asset string, amount float64) float64 {
		switch {
		case asset == quote:
			return amount
		case asset == "SOL":
			return amount * solUSD / quoteUSD
		default: // a $1 stable
			return amount / quoteUSD
		}
	}
	assetOf := func(mint string) string {
		if mint == wsolMint {
			return "SOL"
		}
		return quoteName(mint)
	}
	networkQ := toQuote("SOL", network+rentPaidQ)
	userQ := quoteDelta[quote] // negative on a buy, positive on a sell

	// Pools: the counterparties of the token leg, one per token vault
	// that moved against the user. Each pool's quote vaults are the token
	// accounts of the same swap instruction with the same owner, in a
	// quote mint or, when the pool is quoted in a third asset, in that
	// asset. Without a known swap instruction (a venue we do not list,
	// inside a Jupiter route) the owner's quote accounts are taken instead.
	type pool struct {
		base, owner, venue string
		baseIdx            int
		quoteVaults        []string
		xVaults            []string
		accts              map[string]bool
	}
	var pools []*pool
	for i, e := range tok {
		if e.mint != best.mint || e.owner == user || fee[e.owner] || internal[e.owner] {
			continue
		}
		d := e.post - e.pre
		if d == 0 || (d > 0) == (best.delta > 0) {
			continue
		}
		k := pubkeyAt(i)
		p := &pool{base: k, owner: e.owner, baseIdx: i, accts: map[string]bool{}}
		for _, v := range vixs {
			if v.accts[k] {
				if p.venue == "" {
					p.venue = v.venue
				}
				for a := range v.accts {
					p.accts[a] = true
				}
			}
		}
		if p.venue == "" {
			p.venue = "unknown"
		}
		pools = append(pools, p)
	}
	if len(pools) == 0 {
		return nil, rejectNoPool
	}
	sort.Slice(pools, func(a, b int) bool {
		da, db := math.Abs(tok[pools[a].baseIdx].post-tok[pools[a].baseIdx].pre), math.Abs(tok[pools[b].baseIdx].post-tok[pools[b].baseIdx].pre)
		if da != db {
			return da > db
		}
		return pools[a].base < pools[b].base
	})
	poolAcct := map[string]bool{}
	for _, p := range pools {
		poolAcct[p.base] = true
		if p.venue == "pump-curve" {
			poolAcct[p.owner] = true // the curve account holds the SOL itself
		}
		for i, e := range tok {
			k := pubkeyAt(i)
			if k == p.base || e.owner != p.owner || e.mint == best.mint {
				continue
			}
			if p.venue != "unknown" && !p.accts[k] {
				continue
			}
			if isQuoteMint(e.mint) {
				p.quoteVaults = append(p.quoteVaults, k)
			} else if p.venue != "unknown" {
				p.xVaults = append(p.xVaults, k)
			}
			poolAcct[k] = true
		}
		sort.Strings(p.quoteVaults)
		sort.Strings(p.xVaults)
	}
	main := pools[0]

	// Pool-side quote movement, in the swap's quote unit whatever the pool
	// is quoted in.
	poolQ, quotePre := 0.0, 0.0
	quoteAccounts := 0
	for _, p := range pools {
		for _, k := range p.quoteVaults {
			e := tok[index[k]]
			poolQ += toQuote(assetOf(e.mint), e.delta())
			quotePre += toQuote(assetOf(e.mint), e.pre*math.Pow10(-e.dec))
			quoteAccounts++
		}
		if p.venue == "pump-curve" {
			if i, ok := index[p.owner]; ok {
				poolQ += toQuote("SOL", float64(lam[p.owner])/1e9)
				quotePre += toQuote("SOL", float64(tx.Meta.PreBalances[i])/1e9)
				quoteAccounts++
			}
		}
	}
	poolQ = math.Abs(poolQ)

	// Third asset: the final pool's other side when it is not a quote
	// mint; it moves like the user's token leg (on a buy the pool gives
	// tokens and takes X).
	xMint, xRate, xAmount := "", 0.0, 0.0
	if poolQ == 0 {
		xIn := map[string]float64{}
		for _, p := range pools {
			for _, k := range p.xVaults {
				e := tok[index[k]]
				d := e.delta()
				if d != 0 && (d > 0) == (best.delta > 0) {
					xIn[e.mint] += d
				}
			}
		}
		for m, d := range xIn {
			if xMint == "" || math.Abs(d) > math.Abs(xIn[xMint]) {
				xMint = m
			}
		}
		xAmount = math.Abs(xIn[xMint]) // priced once the hops are read
	}

	// Hops: pool instructions of the route that do not touch a token
	// counterparty (quote → X, or quote → USDC → token). Their own vault
	// movements price X (quote paid in / X paid out) and are excluded
	// from "other". A venue we list qualifies as soon as it moves one
	// foreign token account; a program we do not list (SolFi, ZeroFi,
	// Obric… inside Jupiter routes) needs two, the pair of vaults a pool
	// moves, so a fee-transfer instruction never passes for a hop.
	hops := 0
	hopAccts := map[string]bool{}
	qIn, xOut := 0.0, 0.0
	for _, v := range hixs {
		isFinal := false
		for _, p := range pools {
			if v.accts[p.base] {
				isFinal = true
				break
			}
		}
		if isFinal {
			continue
		}
		// A hop moves someone else's token account; a venue instruction
		// that moves none (Anchor's event self-CPI, account extensions) is
		// not one.
		moving := 0
		owners := map[string]bool{} // hop pool owners: moved a non-quote token here (fee recipients only move quote)
		for k := range v.accts {
			if i, ok := index[k]; ok {
				if e, ok := tok[i]; ok && e.owner != user && !fee[e.owner] && !internal[e.owner] && e.post != e.pre {
					moving++
					if !isQuoteMint(e.mint) {
						owners[e.owner] = true
					}
				}
			}
		}
		if moving == 0 || (v.venue == "" && moving < 2) {
			continue
		}
		hops++
		q, x := 0.0, 0.0
		for k := range v.accts {
			i, ok := index[k]
			if !ok {
				continue
			}
			e, ok := tok[i]
			if !ok || !owners[e.owner] {
				continue
			}
			hopAccts[k] = true
			switch {
			case isQuoteMint(e.mint):
				q += toQuote(assetOf(e.mint), e.delta())
			case xMint != "" && e.mint == xMint:
				x += e.delta()
			}
		}
		if (side == "buy" && q > 0 && x < 0) || (side == "sell" && q < 0 && x > 0) {
			qIn += math.Abs(q)
			xOut += math.Abs(x)
		}
	}
	if xMint != "" {
		if xAmount > 0 && qIn > 0 && xOut > 0 {
			xRate = qIn / xOut
			poolQ = xAmount * xRate
		} else {
			xMint, xRate = "", 0
		}
	}

	// Terminal fee: whatever reached the fee wallets, as lamports, WSOL or a
	// stable, converted to the trade's quote unit.
	terminalQ := 0.0
	for w := range fee {
		if v := lam[w]; v > 0 {
			terminalQ += toQuote("SOL", float64(v)/1e9)
		}
	}
	for _, e := range tok {
		if !fee[e.owner] {
			continue
		}
		d := e.delta()
		if d <= 0 {
			continue
		}
		if e.mint == wsolMint {
			terminalQ += toQuote("SOL", d)
		} else if stableMints[e.mint] {
			terminalQ += toQuote(quoteName(e.mint), d)
		}
	}
	// FOMO: user-signed stable transfers to accounts outside every pool
	// instruction are fee legs (commission split per trade), bounded at
	// 2 % of the trade (or its $0.10 minimum) so a routing leg can never
	// pass for a fee.
	feeLegOwners := map[string]bool{}
	if t.StableLegsAreFee {
		legs := 0.0
		for _, tr := range transfers {
			if tr.authority != user {
				continue
			}
			i, ok := index[tr.dest]
			if !ok {
				continue
			}
			e, ok := tok[i]
			if !ok || !stableMints[e.mint] || e.owner == user || fee[e.owner] || poolAcct[tr.dest] || hopAccts[tr.dest] {
				continue
			}
			inVenue := false
			for _, v := range vixs {
				if v.accts[tr.dest] {
					inVenue = true
					break
				}
			}
			if inVenue {
				continue
			}
			// Each leg on its own: 2 % of the trade, or FOMO's $0.10 minimum
			// on small trades (a $3 buy pays 0.10 USDC: 333 bps), with a
			// little room. A routing transfer that slips in (the user
			// signing the hop vault's input, 98 % of the trade) is dropped
			// alone instead of taking the real legs down with it.
			leg := toQuote(quoteName(e.mint), tr.amount*math.Pow10(-e.dec))
			if leg <= 0 || leg > math.Max(0.02*math.Abs(userQ), 0.12/quoteUSD) {
				continue
			}
			legs += leg
			feeLegOwners[e.owner] = true
		}
		terminalQ += legs
	}

	// Venue label: the final pool's venue; "multi" when the token leg is
	// split across pools.
	venue := main.venue
	if len(pools) > 1 {
		venue = "multi"
	}
	// One constant-product pool on the token leg: keep its pre-trade
	// balances so the exact mid can be computed (see reservePrice). Hops
	// before it do not matter for the mid, only for "other".
	basePre := 0.0
	singleCP := len(pools) == 1 && len(main.quoteVaults) == 1 && len(main.xVaults) == 0 && quoteAccounts == 1 && venuePrograms[venueProgram(main.venue)].cp
	if singleCP {
		basePre = tok[main.baseIdx].pre * math.Pow10(-tok[main.baseIdx].dec)
	} else {
		quotePre = 0
	}

	// Everyone else who received quote: pump.fun fee recipients, creator
	// vaults, referrals, tip services we do not know.
	others := map[string]float64{}
	for i := 0; i < n; i++ {
		k := pubkeyAt(i)
		if k == user || fee[k] || internal[k] || tip(k) || poolAcct[k] || hopAccts[k] || rentPaid[k] {
			continue
		}
		if e, ok := tok[i]; ok {
			if e.owner == user || fee[e.owner] || internal[e.owner] || tip(e.owner) || feeLegOwners[e.owner] {
				continue
			}
			d := e.delta()
			if d > 0 {
				if e.mint == wsolMint {
					others[e.owner] += toQuote("SOL", d)
				} else if stableMints[e.mint] {
					others[e.owner] += toQuote(quoteName(e.mint), d)
				}
			}
			continue
		}
		if v := lam[k]; v > 0 {
			others[k] += toQuote("SOL", float64(v)/1e9)
		}
	}

	// Banana Gun's buy fee: one SOL leg of about 1 % of the trade to an
	// account no list holds (per user or per referrer); the sell fee goes
	// to the listed wallet. The leg closest to 1 % moves from other to fee.
	// Sells pay it too when the listed wallet is not the recipient (a
	// per-user account takes 1 % of the pool's output on part of them).
	if t.SolLegIsFee && userQ != 0 && terminalQ == 0 {
		bestK, bestD := "", 1.0
		for k, v := range others {
			if pumpFeeRecipients[k] {
				continue
			}
			share := v / math.Abs(userQ)
			if d := math.Abs(share - 0.01); share >= 0.008 && share <= 0.012 && d < bestD {
				bestK, bestD = k, d
			}
		}
		if bestK != "" {
			terminalQ += others[bestK]
			delete(others, bestK)
		}
	}

	if sponsoredFee > 0 {
		// The sponsor's gas comes out of the fee the user paid the terminal.
		terminalQ = math.Max(0, terminalQ-toQuote("SOL", sponsoredFee))
	}
	tokens := math.Abs(best.delta) * math.Pow10(-best.dec)
	s := &Swap{
		Method: methodVersion, Sig: sig, Terminal: t.Slug, Slot: tx.Slot, User: user, Side: side, Quote: quote, Venue: venue, Mint: best.mint, Tokens: tokens,
		PoolVault: main.base, PoolOwner: main.owner, PoolQuoteVaults: append(append([]string{}, main.quoteVaults...), main.xVaults...),
		Pools: len(pools), Hops: hops, PoolBasePre: basePre, PoolQuotePre: quotePre, XMint: xMint, XRate: xRate,
		UserQ: math.Abs(userQ), PoolQ: poolQ, TerminalQ: terminalQ, NetworkQ: networkQ, QuoteUSD: quoteUSD,
		Others: others,
	}
	if tx.BlockTime != nil {
		s.Time = *tx.BlockTime
	}
	if rentPaidQ > 0 {
		s.RentQ = rentPaidQ
	}
	// "other": what the user paid minus what the final pool received,
	// the terminal and the network. Exact on single-pool routes (pump.fun
	// protocol and creator fees, referrals). On routed swaps the final
	// pool's input is known through the hop rate, so the same residual
	// holds what the routers and the accounts along the route kept; a
	// residual over a quarter of the trade means a route the parser did
	// not follow, left inside the pool figure as before.
	if poolQ > 0 && main.venue != "unknown" {
		var o float64
		if side == "buy" {
			o = s.UserQ - poolQ - terminalQ - networkQ
		} else {
			o = poolQ - s.UserQ - terminalQ - networkQ
		}
		if o < 0 {
			o = 0
		}
		routed := len(pools) != 1 || hops != 0 || xMint != ""
		if !routed || o <= 0.25*math.Max(s.UserQ, poolQ) {
			s.OtherQ = &o
		}
	}
	if s.UserQ <= 0 && poolQ <= 0 {
		return nil, rejectDegenerate
	}
	s.finalize(nil, 0, "")
	if s.TradeUSD < minTradeUSD {
		return nil, rejectDust
	}
	return s, ""
}

// finalize sets the trade size and every basis-point figure, with the
// token reference price (quote units per token) when one is available.
func (s *Swap) finalize(ref *float64, refAge int64, src string) {
	var trade float64 // in quote units
	s.Priced = false
	s.Flag = ""
	s.LossBps, s.PoolBps, s.RefPrice, s.RefAgeS, s.RefSrc = nil, nil, nil, nil, ""
	if ref != nil && *ref > 0 && s.QuoteUSD > 0 {
		value := s.Tokens * *ref // token leg in quote units
		// The gas counts in what the user gave whenever it was paid in
		// something other than the quote asset. On Solana the quote
		// movement is the user's own lamport balance, so a SOL-quoted swap
		// already carries the fee (see quoteDelta above) and a swap quoted
		// in a stable does not: there the SOL leaves a balance the loss
		// never looks at, and the split then subtracted a cost the base
		// had never been charged.
		gasApart := s.Chain == "" && s.Quote != "SOL"
		var loss float64
		switch s.Side {
		case "buy":
			trade = s.UserQ // on another chain the gas is already inside it
			if gasApart {
				trade += s.NetworkQ
			}
			if trade > 0 {
				loss = 1e4 * (1 - value/trade)
			}
		case "sell":
			trade = value
			if s.Chain != "" || gasApart {
				// The gas was paid apart from the tokens, so what the user
				// gave is the tokens plus that gas.
				trade += s.NetworkQ
			}
			if trade > 0 {
				loss = 1e4 * (1 - s.UserQ/trade)
			}
		}
		if trade > 0 {
			s.RefPrice = ref
			s.RefSrc = src
			s.RefAgeS = &refAge
			s.LossBps = &loss
			// Pool = what is left once the explicit costs are out: LP fee,
			// price impact, and on multi-hop routes the hop costs. The four
			// components always sum to the loss.
			other := 0.0
			if s.OtherQ != nil {
				other = *s.OtherQ
			}
			pool := loss - 1e4*(s.TerminalQ+s.NetworkQ+s.RelayQ+other)/trade
			s.PoolBps = &pool
			if loss < lossMinBps || loss > lossMaxBps {
				s.Flag = "out_of_bounds"
			} else {
				s.Priced = true
			}
		}
	}
	if trade <= 0 {
		other := 0.0
		if s.OtherQ != nil {
			other = *s.OtherQ
		}
		if s.Side == "buy" {
			trade = s.UserQ
		} else {
			trade = math.Max(s.PoolQ, s.UserQ+s.TerminalQ+s.NetworkQ+other)
		}
	}
	s.TradeUSD = trade * s.QuoteUSD
	s.OtherBps = nil
	if trade <= 0 {
		return
	}
	s.TerminalBps = 1e4 * s.TerminalQ / trade
	s.NetworkBps = 1e4 * s.NetworkQ / trade
	s.RelayBps = 1e4 * s.RelayQ / trade
	if s.OtherQ != nil {
		o := 1e4 * *s.OtherQ / trade
		s.OtherBps = &o
	}
}

// poolTradeLeg returns the pool's token and quote movement in another
// transaction, over the pool's own vaults (by pubkey), in the swap's
// quote unit; zero when the transaction did not touch them.
func poolTradeLeg(tx *parsedTx, sw *Swap, solUSD float64) (dTok, dQuote float64) {
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
	msg := tx.Transaction.Message
	n := len(msg.AccountKeys)
	if n == 0 || len(tx.Meta.PreBalances) != n || len(tx.Meta.PostBalances) != n {
		return 0, 0
	}
	index := make(map[string]int, n)
	for i, k := range msg.AccountKeys {
		index[k.Pubkey] = i
	}
	pre := map[int]tokenBalance{}
	for _, b := range tx.Meta.PreTokenBalances {
		pre[b.AccountIndex] = b
	}
	post := map[int]tokenBalance{}
	for _, b := range tx.Meta.PostTokenBalances {
		post[b.AccountIndex] = b
	}
	move := func(pubkey string) (mint string, d float64) {
		i, ok := index[pubkey]
		if !ok {
			return "", 0
		}
		b, ok := post[i]
		if !ok {
			b, ok = pre[i]
			if !ok {
				return "", 0
			}
		}
		p := pre[i].raw()
		if math.IsNaN(p) {
			p = 0
		}
		q := post[i].raw()
		if math.IsNaN(q) {
			q = 0
		}
		return b.Mint, (q - p) * math.Pow10(-b.UITokenAmount.Decimals)
	}
	if _, d := move(sw.PoolVault); d != 0 {
		dTok += d
	}
	for _, v := range sw.PoolQuoteVaults {
		mint, d := move(v)
		switch {
		case mint == wsolMint:
			dQuote += toQuote("SOL", d)
		case stableMints[mint]:
			dQuote += toQuote(quoteName(mint), d)
		case sw.XMint != "" && mint == sw.XMint:
			dQuote += d * sw.XRate
		}
	}
	if sw.Venue == "pump-curve" {
		if i, ok := index[sw.PoolOwner]; ok {
			dQuote += toQuote("SOL", float64(int64(tx.Meta.PostBalances[i])-int64(tx.Meta.PreBalances[i]))/1e9)
		}
	}
	return dTok, dQuote
}

// poolTradePrice reads the effective price of a trade on the swap's pool
// from another transaction: |Δquote| / |Δtoken| over the pool's own
// vaults. Zero when the transaction did not move both legs of that pool.
func poolTradePrice(tx *parsedTx, sw *Swap, solUSD float64) float64 {
	dTok, dQuote := poolTradeLeg(tx, sw, solUSD)
	// A trade moves the legs in opposite directions.
	if dTok == 0 || dQuote == 0 || (dTok > 0) == (dQuote > 0) {
		return 0
	}
	return math.Abs(dQuote) / math.Abs(dTok)
}

// venueProgram returns the program id of a venue name (reverse lookup).
func venueProgram(name string) string {
	for p, v := range venuePrograms {
		if v.name == name {
			return p
		}
	}
	return ""
}

func quoteName(mint string) string {
	switch mint {
	case usdcMint:
		return "USDC"
	case usdtMint:
		return "USDT"
	case usd1Mint:
		return "USD1"
	}
	return ""
}
