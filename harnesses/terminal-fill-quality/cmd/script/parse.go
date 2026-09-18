package main

import (
	"math"
	"sort"
)

// Swap is one sampled, successfully executed swap routed through a
// terminal, reduced to what the user paid and what they got.
//
// Quote-side amounts are exact, from the balance deltas of the
// transaction, in quote units (SOL or a $1 stable):
//
//	UserQ     what left (buy) or reached (sell) the user's quote balance,
//	          rent for new token accounts excluded, tx fee excluded
//	PoolQ     what the pool(s) received (buy) or paid out (sell); 0 when a
//	          multi-hop route hides the quote leg
//	TerminalQ what landed in the terminal's fee wallets
//	NetworkQ  tx fee the user paid (0 when the terminal sponsors gas) +
//	          Jito tips
//	OtherQ    quote that left the user and reached neither pool, terminal
//	          nor network (pump.fun protocol / creator fees, referrals…);
//	          only when PoolQ is known
//
// The token leg (Tokens of Mint) is valued at a reference price read from
// Jupiter's price API right after the sample is taken (see priceSwaps),
// so every venue and route gets the same yardstick:
//
//	buy : loss = 1 − Tokens × ref / (UserQ × quotePrice)
//	sell: loss = 1 − UserQ × quotePrice / (Tokens × ref)
//
// The reference is observed after the trade, so the trade's own price
// impact is only partly inside the figure; RefAgeS records the delay.
type Swap struct {
	Sig      string  `json:"sig"`
	Terminal string  `json:"terminal"`
	Slot     uint64  `json:"slot"`
	Time     int64   `json:"time"`
	Side     string  `json:"side"`  // buy | sell
	Quote    string  `json:"quote"` // SOL | USDC | USDT | USD1
	Venue    string  `json:"venue"`
	Mint     string  `json:"mint"`
	Tokens   float64 `json:"tokens"`

	// Pool identity for the reference-price lookups: the pool's token vault
	// for the traded mint and its owner (pool PDA / AMM authority / curve).
	PoolVault string `json:"pool_vault,omitempty"`
	PoolOwner string `json:"pool_owner,omitempty"`
	// Pre-trade balances of that pool when the route is a single
	// constant-product pool (PumpSwap, pump.fun curve, Raydium v4 / CPMM):
	// token vault in tokens, quote vault in quote units (curve: lamports
	// of the curve account). Zero otherwise.
	PoolBasePre  float64 `json:"pool_base_pre,omitempty"`
	PoolQuotePre float64 `json:"pool_quote_pre,omitempty"`

	UserQ     float64  `json:"user_q"`
	PoolQ     float64  `json:"pool_q"`
	TerminalQ float64  `json:"terminal_q"`
	NetworkQ  float64  `json:"network_q"`
	OtherQ    *float64 `json:"other_q,omitempty"`
	QuoteUSD  float64  `json:"quote_usd"` // quote unit price used for sizing
	// Quote received by accounts that are neither user, pool, terminal nor
	// tip, by pubkey (token accounts keyed by owner): what "other" is made
	// of, aggregated per terminal for audit.
	Others map[string]float64 `json:"others,omitempty"`

	// Set by finalize: reference price of the token (quote units per
	// token), where it came from ("pool": previous trade on the same pool,
	// "jupiter": Jupiter price API after the fact) and the derived figures.
	RefPrice *float64 `json:"ref_price,omitempty"`
	RefSrc   string   `json:"ref_src,omitempty"`
	RefAgeS  *int64   `json:"ref_age_s,omitempty"`
	Priced   bool     `json:"priced"`
	TradeUSD float64  `json:"trade_usd"` // buy: quote spent; sell: tokens × ref (quote received when unpriced)
	// Block scan for a sandwich around this swap (see sandwich.go).
	Scanned      bool      `json:"scanned"`
	BlockPoolTxs int       `json:"block_pool_txs,omitempty"` // other successful trades on the same pool in the block
	Sandwich     *Sandwich `json:"sandwich,omitempty"`
	// Basis points of the trade.
	LossBps     *float64 `json:"loss_bps,omitempty"`
	PoolBps     *float64 `json:"pool_bps,omitempty"`
	TerminalBps float64  `json:"terminal_bps"`
	NetworkBps  float64  `json:"network_bps"`
	OtherBps    *float64 `json:"other_bps,omitempty"`
}

// parseReject explains why a transaction touching a fee wallet is not a
// swap we can measure; counted per terminal for the coverage figures.
type parseReject string

const (
	rejectNotSwap    parseReject = "not_swap"    // no user token leg (wallet funding, fee sweep…)
	rejectTokenSwap  parseReject = "token_token" // neither side is SOL or a stable
	rejectNoPool     parseReject = "no_pool"     // could not identify the counterparty
	rejectDegenerate parseReject = "degenerate"  // zero or negative amounts
	rejectDust       parseReject = "dust"        // under MIN_TRADE_USD, basis points are noise
)

// minTradeUSD: swaps below it are not measured (fixed fees dwarf the
// trade and a few cents of price move read as thousands of bps).
var minTradeUSD = 2.0

// parseSwap reduces a jsonParsed transaction to a Swap (unpriced).
func parseSwap(t Terminal, sig string, tx *parsedTx, solUSD float64) (*Swap, parseReject) {
	msg := tx.Transaction.Message
	n := len(msg.AccountKeys)
	if n == 0 || len(tx.Meta.PreBalances) != n || len(tx.Meta.PostBalances) != n {
		return nil, rejectNotSwap
	}
	fee := set(t.Wallets...)
	internal := set(t.Internal...)
	pubkeyAt := func(i int) string { return msg.AccountKeys[i].Pubkey }

	// Lamport deltas per pubkey.
	lam := make(map[string]int64, n)
	for i := 0; i < n; i++ {
		lam[pubkeyAt(i)] += int64(tx.Meta.PostBalances[i]) - int64(tx.Meta.PreBalances[i])
	}

	// Token balances per account index.
	type tb struct {
		owner, mint string
		dec         int
		pre, post   float64
		hadPre      bool
	}
	tok := map[int]*tb{}
	for _, b := range tx.Meta.PreTokenBalances {
		tok[b.AccountIndex] = &tb{owner: b.Owner, mint: b.Mint, dec: b.UITokenAmount.Decimals, pre: b.raw(), hadPre: true}
	}
	for _, b := range tx.Meta.PostTokenBalances {
		e, ok := tok[b.AccountIndex]
		if !ok {
			e = &tb{owner: b.Owner, mint: b.Mint, dec: b.UITokenAmount.Decimals}
			tok[b.AccountIndex] = e
		}
		if e.owner == "" {
			e.owner = b.Owner
		}
		e.post = b.raw()
	}
	isQuoteMint := func(m string) bool { return m == wsolMint || stableMints[m] }

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
	for _, k := range msg.AccountKeys {
		if !k.Signer || fee[k.Pubkey] || internal[k.Pubkey] {
			continue
		}
		perMint := map[string]*userCand{}
		for _, e := range tok {
			if e.owner != k.Pubkey || isQuoteMint(e.mint) {
				continue
			}
			d := e.post - e.pre
			if math.IsNaN(d) || d == 0 {
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

	// User's quote movements: lamports + WSOL (SOL), and each stable.
	quoteDelta := map[string]float64{}
	quoteDelta["SOL"] = float64(lam[user]) / 1e9
	rent := 0.0
	for i, e := range tok {
		if e.owner != user {
			continue
		}
		if !e.hadPre && i < n {
			// A token account created in this tx: its rent left the user's
			// balance but is not part of the swap.
			rent += float64(tx.Meta.PostBalances[i]) / 1e9
		}
		if e.hadPre && i < n && tx.Meta.PostBalances[i] == 0 && tx.Meta.PreBalances[i] > 0 {
			// A token account closed in this tx (sell everything): its rent
			// came back to the user and is not swap proceeds.
			rent -= float64(tx.Meta.PreBalances[i]) / 1e9
		}
		if e.mint == wsolMint {
			quoteDelta["SOL"] += (e.post - e.pre) * math.Pow10(-e.dec)
		} else if stableMints[e.mint] {
			quoteDelta[quoteName(e.mint)] += (e.post - e.pre) * math.Pow10(-e.dec)
		}
	}
	quoteDelta["SOL"] += rent
	// Network cost: tx fee when the user is the fee payer (account 0), plus
	// Jito tips; the fee is put back into the SOL delta so the swap figure
	// is separate from it.
	network := 0.0
	if pubkeyAt(0) == user {
		network += float64(tx.Meta.Fee) / 1e9
		quoteDelta["SOL"] += float64(tx.Meta.Fee) / 1e9
	}
	for k, v := range lam {
		if isTip(k) && v > 0 {
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
	networkQ := network
	if quote != "SOL" {
		networkQ = network * solUSD // fee and tips are SOL; express in the stable
	}
	userQ := quoteDelta[quote] // negative on a buy, positive on a sell

	// Terminal fee: whatever reached the fee wallets, as lamports, WSOL or a
	// stable, converted to the trade's quote unit.
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
		d := (e.post - e.pre) * math.Pow10(-e.dec)
		if d <= 0 {
			continue
		}
		if e.mint == wsolMint {
			terminalQ += toQuote("SOL", d)
		} else if stableMints[e.mint] {
			terminalQ += toQuote(quoteName(e.mint), d)
		}
	}

	// Venue from the program ids touched.
	progs := map[string]bool{}
	for _, ix := range msg.Instructions {
		progs[ix.ProgramID] = true
	}
	for _, in := range tx.Meta.InnerInstructions {
		for _, ix := range in.Instructions {
			progs[ix.ProgramID] = true
		}
	}
	venues := []string{}
	curve := false
	for p := range progs {
		if v, ok := venuePrograms[p]; ok && v.name != "jupiter" {
			venues = append(venues, v.name)
			if v.name == "pump-curve" {
				curve = true
			}
		}
	}
	sort.Strings(venues)
	venue := "unknown"
	if len(venues) == 1 {
		venue = venues[0]
	} else if len(venues) > 1 {
		venue = "multi"
	}

	// Pool(s): the counterparties of the token leg. Split routes give the
	// user the same token from two pools; both count. Multi-hop routes
	// (quote → X → token) put the quote into a pool that is not a token
	// counterparty, which shows up as PoolQ = 0.
	poolOwners := map[string]bool{}
	poolVault, poolOwner := "", ""
	poolVaultMove := 0.0
	basePre := 0.0
	baseAccounts := 0
	for i, e := range tok {
		if e.mint != best.mint || e.owner == user || fee[e.owner] || internal[e.owner] {
			continue
		}
		d := e.post - e.pre
		if d == 0 || (d > 0) == (best.delta > 0) {
			continue
		}
		poolOwners[e.owner] = true
		baseAccounts++
		basePre += e.pre * math.Pow10(-e.dec)
		if math.Abs(d) > poolVaultMove {
			poolVaultMove = math.Abs(d)
			poolVault = pubkeyAt(i)
			poolOwner = e.owner
		}
	}
	if len(poolOwners) == 0 {
		return nil, rejectNoPool
	}
	// Pool-side quote movement, in the swap's quote unit whatever the pool
	// is quoted in (FOMO pays USDC into SOL-quoted pools via a hop).
	poolQ := 0.0
	quotePre := 0.0
	quoteAccounts := 0
	for _, e := range tok {
		if !poolOwners[e.owner] {
			continue
		}
		d := (e.post - e.pre) * math.Pow10(-e.dec)
		if e.mint == wsolMint {
			poolQ += toQuote("SOL", d)
			quotePre += toQuote("SOL", e.pre*math.Pow10(-e.dec))
			quoteAccounts++
		} else if stableMints[e.mint] {
			poolQ += toQuote(quoteName(e.mint), d)
			quotePre += toQuote(quoteName(e.mint), e.pre*math.Pow10(-e.dec))
			quoteAccounts++
		}
	}
	if curve {
		// The bonding curve holds SOL natively on its own account.
		for o := range poolOwners {
			poolQ += toQuote("SOL", float64(lam[o])/1e9)
			quotePre += toQuote("SOL", float64(tx.Meta.PreBalances[indexOf(msg.AccountKeys, o)])/1e9)
			quoteAccounts++
		}
	}
	poolQ = math.Abs(poolQ)
	// Single constant-product pool: keep its pre-trade balances so the
	// exact mid can be computed (see reservePrice).
	singleCP := len(poolOwners) == 1 && baseAccounts == 1 && quoteAccounts == 1 && len(venues) == 1 && venuePrograms[venueProgram(venues[0])].cp
	if !singleCP {
		basePre, quotePre = 0, 0
	}

	// Everyone else who received quote: pump.fun fee recipients, creator
	// vaults, referrals, tip services we do not know, hop pools.
	others := map[string]float64{}
	isUserAcct := map[int]bool{}
	for i, e := range tok {
		if e.owner == user {
			isUserAcct[i] = true
		}
	}
	for i := 0; i < n; i++ {
		k := pubkeyAt(i)
		if k == user || fee[k] || internal[k] || isTip(k) || poolOwners[k] || isUserAcct[i] {
			continue
		}
		if e, ok := tok[i]; ok {
			if poolOwners[e.owner] || fee[e.owner] || internal[e.owner] {
				continue
			}
			d := (e.post - e.pre) * math.Pow10(-e.dec)
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

	tokens := math.Abs(best.delta) * math.Pow10(-best.dec)
	s := &Swap{
		Sig: sig, Terminal: t.Slug, Slot: tx.Slot, Side: side, Quote: quote, Venue: venue, Mint: best.mint, Tokens: tokens,
		PoolVault: poolVault, PoolOwner: poolOwner, PoolBasePre: basePre, PoolQuotePre: quotePre,
		UserQ: math.Abs(userQ), PoolQ: poolQ, TerminalQ: terminalQ, NetworkQ: networkQ, QuoteUSD: quoteUSD,
		Others: others,
	}
	if tx.BlockTime != nil {
		s.Time = *tx.BlockTime
	}
	// "other" is known on single-venue routes (one pool, no hop): what the
	// user paid minus pool, terminal and network. On multi-hop routes the
	// hop pools hide it; it stays inside the derived pool figure.
	if poolQ > 0 && venue != "multi" && len(poolOwners) == 1 {
		var o float64
		if side == "buy" {
			o = s.UserQ - poolQ - terminalQ - networkQ
		} else {
			o = poolQ - s.UserQ - terminalQ - networkQ
		}
		if o < 0 {
			o = 0
		}
		s.OtherQ = &o
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
	s.LossBps, s.PoolBps, s.RefPrice, s.RefAgeS, s.RefSrc = nil, nil, nil, nil, ""
	if ref != nil && *ref > 0 && s.QuoteUSD > 0 {
		value := s.Tokens * *ref // token leg in quote units
		var loss float64
		switch s.Side {
		case "buy":
			trade = s.UserQ
			if trade > 0 {
				loss = 1e4 * (1 - value/trade)
			}
		case "sell":
			trade = value
			if trade > 0 {
				loss = 1e4 * (1 - s.UserQ/trade)
			}
		}
		if trade > 0 {
			s.Priced = true
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
			pool := loss - 1e4*(s.TerminalQ+s.NetworkQ+other)/trade
			s.PoolBps = &pool
		}
	}
	if !s.Priced {
		if s.Side == "buy" {
			trade = s.UserQ
		} else if s.PoolQ > 0 {
			trade = s.PoolQ
		} else {
			trade = s.UserQ + s.TerminalQ + s.NetworkQ
		}
	}
	s.TradeUSD = trade * s.QuoteUSD
	s.OtherBps = nil
	if trade <= 0 {
		return
	}
	s.TerminalBps = 1e4 * s.TerminalQ / trade
	s.NetworkBps = 1e4 * s.NetworkQ / trade
	if s.OtherQ != nil {
		o := 1e4 * *s.OtherQ / trade
		s.OtherBps = &o
	}
}

// poolTradePrice reads the effective price of a trade on one pool from
// another transaction: |Δquote| / |Δtoken| over the pool's own accounts,
// in the given quote unit (pool quote converted through SOL/USD when it
// differs). Zero when the transaction did not move both legs of that pool.
func poolTradePrice(tx *parsedTx, poolOwner, mint, quote string, quoteUSD, solUSD float64, curve bool) float64 {
	toQuote := func(asset string, amount float64) float64 {
		switch {
		case asset == quote:
			return amount
		case asset == "SOL":
			return amount * solUSD / quoteUSD
		default:
			return amount / quoteUSD
		}
	}
	msg := tx.Transaction.Message
	n := len(msg.AccountKeys)
	if n == 0 || len(tx.Meta.PreBalances) != n {
		return 0
	}
	pre := map[int]tokenBalance{}
	for _, b := range tx.Meta.PreTokenBalances {
		pre[b.AccountIndex] = b
	}
	var dTok, dQuote float64
	for _, b := range tx.Meta.PostTokenBalances {
		if b.Owner != poolOwner {
			continue
		}
		p := pre[b.AccountIndex]
		d := (b.raw() - p.raw()) * math.Pow10(-b.UITokenAmount.Decimals)
		if math.IsNaN(d) {
			continue
		}
		switch {
		case b.Mint == mint:
			dTok += d
		case b.Mint == wsolMint:
			dQuote += toQuote("SOL", d)
		case stableMints[b.Mint]:
			dQuote += toQuote(quoteName(b.Mint), d)
		}
	}
	if curve {
		for i, k := range msg.AccountKeys {
			if k.Pubkey == poolOwner {
				dQuote += toQuote("SOL", float64(int64(tx.Meta.PostBalances[i])-int64(tx.Meta.PreBalances[i]))/1e9)
			}
		}
	}
	// A trade moves the legs in opposite directions.
	if dTok == 0 || dQuote == 0 || (dTok > 0) == (dQuote > 0) {
		return 0
	}
	return math.Abs(dQuote) / math.Abs(dTok)
}

func indexOf(keys []struct {
	Pubkey string `json:"pubkey"`
	Signer bool   `json:"signer"`
}, pubkey string) int {
	for i, k := range keys {
		if k.Pubkey == pubkey {
			return i
		}
	}
	return 0
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
