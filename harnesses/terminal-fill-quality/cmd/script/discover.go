package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// Cohort discovery: the terminals' fee wallets and routers are learned
// from the chain instead of maintained by hand.
//
// A terminal's fee wallet is a recipient that, across many swaps of
// distinct payers, always takes the same share of the trade (Axiom 1 %,
// Phantom 0.85 %, Jupiter Ultra 10 bps); pool vaults, Jito tips and
// pump.fun's fees each have another signature. So on a sample of a
// platform's transactions, the recipients of the "other" leg are grouped,
// and the ones with a fixed share over enough distinct payers become the
// platform's wallets. Mobula's trades feed (`trades/filters`, platform
// attribution) gives the sample per platform; the hardcoded lists are
// the seed. On the EVM chains the transactions' `to` gives the router.
//
// Every DISCOVER_EVERY ticks (6 h by default): per platform, up to 40
// recent transactions; evidence (swaps, distinct payers, share median,
// first / last seen) is persisted in the state; a candidate is adopted at
// runtime (the feed resubscribes) from 30 swaps of 20 distinct payers
// with a share between 20 and 300 bps whose quartiles sit within 30 % of
// the median. Programs invoked at top level are reported, not adopted.
// Independently of Mobula, the window's sampled swaps give the
// unattributed fee-like recipients: the terminals nobody listed yet.

type Evidence struct {
	N        int             `json:"n"`
	PayerSet map[string]bool `json:"payer_set,omitempty"` // capped at 64
	Payers   int             `json:"payers"`
	Bps      []float64       `json:"bps,omitempty"` // last 64 shares
	BpsMed   float64         `json:"bps_median"`
	First    int64           `json:"first"`
	Last     int64           `json:"last"`
	Adopted  bool            `json:"adopted,omitempty"`
}

func (e *Evidence) add(payer string, bps float64, now int64) {
	e.N++
	if e.First == 0 {
		e.First = now
	}
	e.Last = now
	if e.PayerSet == nil {
		e.PayerSet = map[string]bool{}
	}
	if len(e.PayerSet) < 64 {
		e.PayerSet[payer] = true
	}
	e.Payers = len(e.PayerSet)
	if bps > 0 {
		e.Bps = append(e.Bps, bps)
		if len(e.Bps) > 64 {
			e.Bps = e.Bps[len(e.Bps)-64:]
		}
		e.BpsMed = median(e.Bps)
	}
}

// stable: enough swaps and payers, a fee-sized share, and quartiles
// close to the median (a fixed percentage, not a price-dependent leg).
func (e *Evidence) stable() bool {
	if e.N < 30 || e.Payers < 20 || e.BpsMed < 20 || e.BpsMed > 300 || len(e.Bps) < 20 {
		return false
	}
	s := append([]float64{}, e.Bps...)
	sort.Float64s(s)
	p25, p75 := s[len(s)/4], s[len(s)*3/4]
	return p25 >= 0.7*e.BpsMed && p75 <= 1.3*e.BpsMed
}

type Learned struct {
	Wallets  map[string]*Evidence `json:"wallets,omitempty"`
	Programs map[string]*Evidence `json:"programs,omitempty"`
	Routers  map[string]*Evidence `json:"routers,omitempty"`
	Sampled  int                  `json:"sampled"` // transactions read for this platform, all runs
}

func (l *Learned) bucket(kind string) map[string]*Evidence {
	var m *map[string]*Evidence
	switch kind {
	case "wallets":
		m = &l.Wallets
	case "programs":
		m = &l.Programs
	default:
		m = &l.Routers
	}
	if *m == nil {
		*m = map[string]*Evidence{}
	}
	return *m
}

type Unattributed struct {
	Pubkey   string   `json:"pubkey"`
	Users    int      `json:"users"`
	Count    int      `json:"count"`
	BpsMed   float64  `json:"bps_median"`
	QuoteUSD float64  `json:"quote_usd"`
	Seen     []string `json:"seen_with"` // terminals whose swaps paid it
}

type Discovery struct {
	RanAt        int64               `json:"ran_at"`
	Source       string              `json:"source"`
	Platforms    map[string]*Learned `json:"platforms,omitempty"`
	Unattributed []Unattributed      `json:"unattributed,omitempty"`
	Adopted      []string            `json:"adopted,omitempty"` // this run
	Note         string              `json:"note"`
}

// mobulaPlatforms: Mobula's platform names (lower case) per chain → our row.
var mobulaPlatforms = map[string]map[string]string{
	"solana":   {"axiom": "axiom", "fomo": "fomo", "trojan": "trojan", "padre": "padre", "gmgn": "gmgn", "phantom": "phantom", "bloom": "bloom", "photon": "photon", "banana gun": "banana-gun", "maestro": "maestro", "pepeboost": "pepeboost", "bonkbot": "bonkbot"},
	"bsc":      {"gmgn": "gmgn-bnb", "binance wallet": "binance-wallet-bnb", "axiom": "axiom-bnb", "banana gun": "banana-gun-bnb"},
	"ethereum": {"banana gun": "banana-gun-ethereum", "binance wallet": "binance-wallet-ethereum"},
	"base":     {"binance wallet": "binance-wallet-base", "banana gun": "banana-gun-base"},
}

var mobulaChainSlug = map[string]string{"bsc": "bnb", "ethereum": "ethereum", "base": "base"}

// standardPrograms never count as a platform's router.
var standardPrefixes = []string{"ComputeBudget", "11111111", "Tokenkeg", "TokenzQd", "ATokenGP", "Memo", "JUP6LkbZ", "jupoNjAx", "REFER4Zg", "AddressLookup", "SysvarRent"}

func isStandardProgram(p string) bool {
	if _, ok := venuePrograms[p]; ok {
		return true
	}
	for _, pre := range standardPrefixes {
		if strings.HasPrefix(p, pre) {
			return true
		}
	}
	return false
}

// cohortMu guards the runtime edits of the terminal lists.
var cohortMu sync.RWMutex

// mobulaTrades: a platform's recent transaction hashes and payers per chain.
func mobulaTrades(ctx context.Context, httpc *http.Client, key, chain string) (map[string][][2]string, error) {
	now := time.Now().UnixMilli()
	q := url.Values{"blockchain": {chain}, "from": {fmt.Sprint(now - 3600_000)}, "to": {fmt.Sprint(now)}, "limit": {"5000"}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.mobula.io/api/2/trades/filters?"+q.Encode(), nil)
	req.Header.Set("Authorization", key)
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("mobula %s: HTTP %d", chain, resp.StatusCode)
	}
	var env struct {
		Data []struct {
			Platform struct {
				Name string `json:"name"`
			} `json:"platform"`
			Hash   string `json:"transactionHash"`
			Sender string `json:"transactionSenderAddress"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, err
	}
	out := map[string][][2]string{}
	seen := map[string]bool{}
	for _, t := range env.Data {
		slug := mobulaPlatforms[chain][strings.ToLower(t.Platform.Name)]
		if slug == "" || t.Hash == "" || seen[t.Hash] {
			continue
		}
		seen[t.Hash] = true
		if len(out[slug]) < 40 {
			out[slug] = append(out[slug], [2]string{t.Hash, strings.ToLower(t.Sender)})
		}
	}
	return out, nil
}

func terminalIndex(slug string) int {
	for i := range terminals {
		if terminals[i].Slug == slug {
			return i
		}
	}
	return -1
}

func evmTerminalIndex(slug string) int {
	for i := range evmTerminals {
		if evmTerminals[i].Slug == slug {
			return i
		}
	}
	return -1
}

// applyLearned puts the wallets and routers adopted by earlier runs back
// on the terminals at start (the lists in the code are the seed).
func applyLearned(st *State) {
	n := 0
	for slug, l := range st.Learned {
		if i := terminalIndex(slug); i >= 0 {
			known := set(terminals[i].Wallets...)
			for w, e := range l.Wallets {
				if e.Adopted && !known[w] {
					terminals[i].Wallets = append(terminals[i].Wallets, w)
					n++
				}
			}
		}
		if i := evmTerminalIndex(slug); i >= 0 {
			known := set(evmTerminals[i].Routers...)
			for k, e := range l.Routers {
				addr := k[strings.Index(k, ":")+1:]
				if e.Adopted && !known[addr] {
					evmTerminals[i].Routers = append(evmTerminals[i].Routers, addr)
					n++
				}
			}
		}
	}
	if n > 0 {
		log.Printf("[discover] %d learned wallets / routers applied from the state", n)
	}
}

// discover runs one discovery pass; it edits the terminal lists in place
// (under cohortMu) and says whether the Solana feed must resubscribe.
func discover(ctx context.Context, rpc *rpcClient, httpc *http.Client, st *State, solUSD float64, now int64) (*Discovery, bool) {
	if st.Learned == nil {
		st.Learned = map[string]*Learned{}
	}
	d := &Discovery{RanAt: now, Platforms: st.Learned, Note: "Fee wallets and routers learned from the chain: on a platform's transactions (Mobula's attribution as the sample), a recipient taking a fixed share of the trade across many payers is the platform's fee wallet, the transactions' `to` on EVM its router; adopted from 30 swaps of 20 payers with a stable 20–300 bps share. Unattributed: fee-like recipients in the window's sampled swaps that no terminal lists."}
	d.Unattributed = unattributedFees(st)
	key := os.Getenv("MOBULA_API_KEY")
	if key == "" {
		d.Source = "window swaps only (no MOBULA_API_KEY)"
		return d, false
	}
	d.Source = "mobula trades/filters, last hour per chain"
	resub := false
	for chain := range mobulaPlatforms {
		byPlat, err := mobulaTrades(ctx, httpc, key, chain)
		if err != nil {
			log.Printf("[discover] %v", err)
			continue
		}
		for slug, txs := range byPlat {
			l := st.Learned[slug]
			if l == nil {
				l = &Learned{}
				st.Learned[slug] = l
			}
			if chain == "solana" {
				if learnSolana(ctx, rpc, l, slug, txs, solUSD, now) {
					resub = true
					d.Adopted = append(d.Adopted, slug)
				}
			} else if learnEVM(ctx, httpc, l, slug, mobulaChainSlug[chain], txs, now) {
				d.Adopted = append(d.Adopted, slug)
			}
		}
	}
	return d, resub
}

// learnSolana reads a platform's transactions through the swap parser and
// scores the "other" recipients and the top-level programs.
func learnSolana(ctx context.Context, rpc *rpcClient, l *Learned, slug string, txs [][2]string, solUSD float64, now int64) bool {
	i := terminalIndex(slug)
	if i < 0 {
		return false
	}
	cohortMu.RLock()
	t := terminals[i]
	cohortMu.RUnlock()
	known := set(t.Wallets...)
	for _, w := range t.Tips {
		known[w] = true
	}
	for _, w := range t.Internal {
		known[w] = true
	}
	for _, w := range t.Programs {
		known[w] = true
	}
	for _, x := range txs {
		sig := x[0]
		tx, err := rpc.transaction(ctx, sig)
		if err != nil || tx == nil || (len(tx.Meta.Err) > 0 && string(tx.Meta.Err) != "null") {
			continue
		}
		l.Sampled++
		// Programs invoked at top level, the platform's own router among them.
		payer := ""
		if len(tx.Transaction.Message.AccountKeys) > 0 {
			payer = tx.Transaction.Message.AccountKeys[0].Pubkey
		}
		progs := map[string]bool{}
		for _, ix := range tx.Transaction.Message.Instructions {
			if ix.ProgramID != "" && !isStandardProgram(ix.ProgramID) && !known[ix.ProgramID] {
				progs[ix.ProgramID] = true
			}
		}
		for p := range progs {
			e := l.bucket("programs")[p]
			if e == nil {
				e = &Evidence{}
				l.bucket("programs")[p] = e
			}
			e.add(payer, 0, now)
		}
		sw, _ := parseSwap(t, sig, tx, solUSD, "")
		if sw == nil || sw.OtherQ == nil || sw.TradeUSD <= 0 || sw.QuoteUSD <= 0 {
			continue
		}
		trade := sw.TradeUSD / sw.QuoteUSD
		for r, q := range sw.Others {
			if known[r] || isTip(r) || pumpFeeRecipients[r] || r == sw.User {
				continue
			}
			e := l.bucket("wallets")[r]
			if e == nil {
				e = &Evidence{}
				l.bucket("wallets")[r] = e
			}
			e.add(sw.User, 1e4*q/trade, now)
		}
	}
	adopted := false
	for w, e := range l.Wallets {
		if e.Adopted || !e.stable() {
			continue
		}
		e.Adopted = true
		adopted = true
		cohortMu.Lock()
		terminals[i].Wallets = append(append([]string{}, terminals[i].Wallets...), w)
		cohortMu.Unlock()
		log.Printf("[discover] %s: fee wallet %s adopted (%d swaps, %d payers, %.0f bps median)", slug, w, e.N, e.Payers, e.BpsMed)
	}
	return adopted
}

// learnEVM scores the transactions' `to` for a platform's chain row.
func learnEVM(ctx context.Context, httpc *http.Client, l *Learned, slug, chain string, txs [][2]string, now int64) bool {
	i := evmTerminalIndex(slug)
	if i < 0 {
		return false
	}
	var c *originChain
	for k := range originChains {
		if originChains[k].slug == chain {
			c = &originChains[k]
		}
	}
	if c == nil {
		return false
	}
	cohortMu.RLock()
	known := set(evmTerminals[i].Routers...)
	cohortMu.RUnlock()
	total := 0
	for _, x := range txs {
		var tx evmTx
		if err := evmCall(ctx, httpc, c.rpc, "eth_getTransactionByHash", []any{x[0]}, &tx); err != nil || tx.To == "" {
			continue
		}
		l.Sampled++
		total++
		to := strings.ToLower(tx.To)
		if known[to] {
			continue
		}
		e := l.bucket("routers")[chain+":"+to]
		if e == nil {
			e = &Evidence{}
			l.bucket("routers")[chain+":"+to] = e
		}
		e.add(strings.ToLower(tx.From), 0, now)
	}
	adopted := false
	for k, e := range l.Routers {
		if e.Adopted || e.N < 30 || e.Payers < 20 || !strings.HasPrefix(k, chain+":") {
			continue
		}
		// The router carries most of the platform's transactions.
		if l.Sampled == 0 || float64(e.N) < 0.6*float64(l.Sampled) {
			continue
		}
		e.Adopted = true
		adopted = true
		addr := strings.TrimPrefix(k, chain+":")
		cohortMu.Lock()
		evmTerminals[i].Routers = append(append([]string{}, evmTerminals[i].Routers...), addr)
		cohortMu.Unlock()
		log.Printf("[discover] %s: router %s adopted (%d transactions, %d senders)", slug, addr, e.N, e.Payers)
	}
	return adopted
}

// unattributedFees: over the window's sampled swaps, the "other"
// recipients no terminal lists that look like a fee wallet (many users,
// a stable fee-sized share).
func unattributedFees(st *State) []Unattributed {
	listed := map[string]bool{}
	cohortMu.RLock()
	for _, t := range terminals {
		for _, w := range t.scanAddresses() {
			listed[w] = true
		}
		for _, w := range t.Tips {
			listed[w] = true
		}
		for _, w := range t.Internal {
			listed[w] = true
		}
	}
	cohortMu.RUnlock()
	type agg struct {
		users map[string]bool
		bps   []float64
		count int
		quote float64
		seen  map[string]bool
	}
	m := map[string]*agg{}
	for _, s := range st.Swaps {
		if s.Method != methodVersion || s.OtherQ == nil || s.TradeUSD <= 0 || s.QuoteUSD <= 0 {
			continue
		}
		trade := s.TradeUSD / s.QuoteUSD
		for r, q := range s.Others {
			if listed[r] || isTip(r) || pumpFeeRecipients[r] || r == s.User || q <= 0 {
				continue
			}
			a := m[r]
			if a == nil {
				a = &agg{users: map[string]bool{}, seen: map[string]bool{}}
				m[r] = a
			}
			a.users[s.User] = true
			a.bps = append(a.bps, 1e4*q/trade)
			a.count++
			a.quote += q * s.QuoteUSD
			a.seen[s.Terminal] = true
		}
	}
	var out []Unattributed
	for r, a := range m {
		med := median(a.bps)
		if len(a.users) < 10 || med < 5 || med > 300 {
			continue
		}
		var seen []string
		for k := range a.seen {
			seen = append(seen, k)
		}
		sort.Strings(seen)
		out = append(out, Unattributed{Pubkey: r, Users: len(a.users), Count: a.count, BpsMed: med, QuoteUSD: a.quote, Seen: seen})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].QuoteUSD > out[j].QuoteUSD })
	if len(out) > 12 {
		out = out[:12]
	}
	return out
}
