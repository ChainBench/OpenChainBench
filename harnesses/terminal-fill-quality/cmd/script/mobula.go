package main

// FOMO's other cross-chain rail: Mobula.
//
// Relay is not the only way out of Solana. Measured over 398 of FOMO's
// sponsor transactions, Relay carried 17 and Mobula 6, so about a quarter of
// FOMO's bridging was invisible to this bench while the Relay feed looked
// healthy. Published as its own route rather than folded into FOMO, because
// the two rails differ in fee and in speed and averaging them would describe
// neither: the same reason pump's own bridge is a row beside the pump.fun app.
//
// WHY THIS PAIRING IS NOT THE PUMP PAIRING. Pump encrypts its destination, so
// the only join available there is "invert the fee schedule and search a time
// window by amount", which accepts an unrelated deposit of the same implied
// size as a unique match and cost a full night of false tails and censored
// windows. Mobula states an intent id in the clear on BOTH legs:
//
//	Solana deposit   a memo instruction from mobulaMemoProgram carrying
//	                 {"intentId":"5976756-d392c16-095"}
//	EVM fill         the same id as right-padded ascii in word 0 of the
//	                 mobulaFillTopic event's data
//
// Verified 29 of 29 one way and 14 of 14 the other, matching only the full
// dashed id (38 hex characters). The window here is therefore a MAP keyed by
// that id: a hit is a fact, not a probability, and there is no "ambiguous"
// outcome to report because two intents cannot share an id.
//
// ATTRIBUTION IS STILL THE FEE PAYER, not the memo. Any Mobula integrator
// writes the same memo, so the id proves which fill answers which deposit and
// says nothing about whose user it was. The app is the Solana transaction's
// fee payer, exactly as for Relay, and only the apps declared on the Mobula
// rail in settleRails are attributed: anything else is counted apart rather
// than absorbed into FOMO's row or dropped in silence.

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	gMobulaUp = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "tfq_mobula_feed_up",
		Help: "1 when the Mobula deposit poller read the solver's token account on its last pass. Separate from the Relay and Pump Bridge feeds: an app can ride several rails, so one feed being healthy says nothing about another",
	})
	cMobulaDeposits = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_mobula_deposits_total",
		Help: "Deposits seen crediting Mobula's solver, by the app that paid the Solana fee. app=undeclared means the fee payer is not an app declared on the Mobula rail in settleRails: counted rather than dropped, because that is how a new integrator's flow becomes visible instead of silently joining someone else's row",
	}, []string{"app"})
	cMobulaFills = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_mobula_fills_total",
		Help: "Fill events read from Mobula's bridge contract, by whether the intent id matched a deposit we hold. paired is an EXACT join on an id stated in the clear on both legs, so unlike the Pump Bridge pairing there is no ambiguous case and no amount tolerance. unknown_intent means the deposit was never seen or has aged out: our blindness, never a bridge failure, and it is the normal state for fills belonging to other integrators",
	}, []string{"chain", "result"})
)

func init() {
	prometheus.MustRegister(gMobulaUp, cMobulaDeposits, cMobulaFills)
}

// mobulaIntentAge: how long a deposit is held waiting for its fill.
//
// Mobula's own explorer reports 260 ms to 4.1 s, so the bridge itself needs
// seconds. This is sized for OUR lag instead: the fill watcher reads a block
// range on a ticker, so a fill can reach us minutes after it landed. Same
// reach as the pump window, for the same reason.
const mobulaIntentAge = 30 * 60

// mobulaIntentMax caps the window so a quiet fill watcher cannot grow it
// without bound.
const mobulaIntentMax = 4000

// mobulaIntent: one deposit, kept only long enough to find its fill.
type mobulaIntent struct {
	At      int64   `json:"at"`      // unix seconds, Solana blockTime
	Amount  float64 `json:"amount"`  // USDC credited to the solver
	App     string  `json:"app"`     // the product this route publishes under
	User    string  `json:"user"`    // the Solana depositor
	Deposit string  `json:"deposit"` // the Solana signature
}

// mobulaWindow: deposits by intent id. A map and not a slice, because the
// join key is exact: the pump window has to be scanned by amount and time,
// this one is a lookup.
var mobulaWindow struct {
	sync.Mutex
	by map[string]mobulaIntent
}

// mobulaNoteDeposit records a deposit and ages the window.
func mobulaNoteDeposit(id string, in mobulaIntent) {
	if id == "" || in.At <= 0 || in.Amount <= 0 {
		return
	}
	mobulaWindow.Lock()
	defer mobulaWindow.Unlock()
	if mobulaWindow.by == nil {
		mobulaWindow.by = map[string]mobulaIntent{}
	}
	mobulaWindow.by[id] = in
	if len(mobulaWindow.by) <= mobulaIntentMax {
		// Age out on the way past the cap only. A map has no order, so
		// pruning by age every insert would walk the whole window on
		// every deposit for no benefit.
		cut := in.At - mobulaIntentAge
		for k, v := range mobulaWindow.by {
			if v.At < cut {
				delete(mobulaWindow.by, k)
			}
		}
		return
	}
	cut := in.At - mobulaIntentAge
	for k, v := range mobulaWindow.by {
		if v.At < cut {
			delete(mobulaWindow.by, k)
		}
	}
	// Still over: drop the oldest until it fits, so the cap is a cap.
	for len(mobulaWindow.by) > mobulaIntentMax {
		oldestK, oldestAt := "", int64(0)
		for k, v := range mobulaWindow.by {
			if oldestAt == 0 || v.At < oldestAt {
				oldestK, oldestAt = k, v.At
			}
		}
		if oldestK == "" {
			break
		}
		delete(mobulaWindow.by, oldestK)
	}
}

// mobulaTakeIntent returns a deposit and removes it: a fill consumes its
// intent, so a replayed log cannot be counted twice.
func mobulaTakeIntent(id string) (mobulaIntent, bool) {
	mobulaWindow.Lock()
	defer mobulaWindow.Unlock()
	v, ok := mobulaWindow.by[id]
	if ok {
		delete(mobulaWindow.by, id)
	}
	return v, ok
}

// mobulaSaveIntents and mobulaLoadIntents carry the window across a restart,
// for the reason measured on the pump window: a deploy otherwise empties it
// and the settlement column goes blank for as long as it takes to refill,
// and this bench is deployed several times an hour on a busy evening.
func mobulaSaveIntents() map[string]mobulaIntent {
	mobulaWindow.Lock()
	defer mobulaWindow.Unlock()
	out := make(map[string]mobulaIntent, len(mobulaWindow.by))
	for k, v := range mobulaWindow.by {
		out[k] = v
	}
	return out
}

func mobulaLoadIntents(in map[string]mobulaIntent, now int64) int {
	if len(in) == 0 {
		return 0
	}
	kept := map[string]mobulaIntent{}
	for k, v := range in {
		if k == "" || v.At <= 0 || v.Amount <= 0 || now-v.At > mobulaIntentAge {
			continue
		}
		kept[k] = v
	}
	mobulaWindow.Lock()
	mobulaWindow.by = kept
	mobulaWindow.Unlock()
	return len(kept)
}

// mobulaApps: Solana fee payer -> the product its Mobula flow publishes under.
//
// Built from the terminals' own Internal addresses (their gas sponsors) rather
// than hardcoded, so it stays in step with the config, and GATED on
// settleRails: a sponsor is only attributed when "<slug>-mobula" is declared
// on the Mobula rail. Without that gate a new app appearing on this rail would
// publish under a product the bench cannot name, which is how lane="bridge"
// hid 180,682 trades.
func mobulaApps() map[string]string {
	declared := map[string]bool{}
	for _, p := range settleRails["mobula"] {
		declared[p] = true
	}
	out := map[string]string{}
	for _, t := range terminals {
		product := t.Slug + "-mobula"
		if !declared[product] {
			continue
		}
		for _, a := range t.Internal {
			out[a] = product
		}
	}
	return out
}

// mobulaFeed walks the solver's token account forward from where it stopped.
type mobulaFeed struct {
	cursor string
	apps   map[string]string
}

func newMobulaFeed() *mobulaFeed {
	return &mobulaFeed{apps: mobulaApps()}
}

func (f *mobulaFeed) run(ctx context.Context, rpc *rpcClient, every time.Duration) {
	if len(f.apps) == 0 {
		log.Printf("[mobula] no app declared on the mobula rail in settleRails: feed not started")
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	f.poll(ctx, rpc)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f.poll(ctx, rpc)
		}
	}
}

// poll reads what credited the solver since the last pass.
//
// The solver's USDC token account is the subscription point, not the solver
// address: a deposit credits the TOKEN ACCOUNT, whose address has no
// relationship to its owner's, which is why 15,000 transactions were once
// scanned against the solver address for nothing.
func (f *mobulaFeed) poll(ctx context.Context, rpc *rpcClient) {
	sigs, err := rpc.signatures(ctx, mobulaSolverUSDC, 200, f.cursor)
	if err != nil {
		gMobulaUp.Set(0)
		log.Printf("[mobula] signatures: %v", err)
		return
	}
	gMobulaUp.Set(1)
	if len(sigs) == 0 {
		return
	}
	newest := sigs[0].Signature
	found, scanned := 0, 0
	for _, s := range sigs {
		if ctx.Err() != nil {
			break
		}
		if s.failed() {
			continue
		}
		tx, err := rpc.transaction(ctx, s.Signature)
		if err != nil || tx == nil || tx.BlockTime == nil {
			continue
		}
		scanned++
		keys := tx.Transaction.Message.AccountKeys
		if len(keys) == 0 {
			continue
		}
		app, ok := f.apps[keys[0].Pubkey]
		if !ok {
			// Another integrator's flow, or the solver's own rebalancing
			// (it fee-pays its own transactions). Counted so a new rail
			// user is visible rather than absorbed.
			cMobulaDeposits.WithLabelValues("undeclared").Inc()
			continue
		}
		id := mobulaIntentOf(tx)
		if id == "" {
			continue
		}
		amt := mobulaCredited(tx)
		if amt <= 0 {
			continue
		}
		mobulaNoteDeposit(id, mobulaIntent{
			At: *tx.BlockTime, Amount: amt, App: app,
			User: mobulaDepositor(tx), Deposit: s.Signature,
		})
		cMobulaDeposits.WithLabelValues(app).Inc()
		found++
	}
	f.cursor = newest
	if found > 0 {
		log.Printf("[mobula] %d deposits in %d transactions, window holds %d intents",
			found, scanned, mobulaWindowLen())
	}
}

func mobulaWindowLen() int {
	mobulaWindow.Lock()
	defer mobulaWindow.Unlock()
	return len(mobulaWindow.by)
}

// mobulaIntentOf reads the intent id out of the memo instruction.
//
// The memo program puts its text in `parsed` as a bare JSON string, which is
// why this unmarshals into a string before unmarshalling the text itself. The
// probe that first looked for this read `data` instead and reported "no memo
// instruction" while 42 memo invocations sat in the same output: jsonParsed
// replaces data with parsed for programs the RPC knows.
func mobulaIntentOf(tx *parsedTx) string {
	for _, ix := range tx.Transaction.Message.Instructions {
		if ix.ProgramID != mobulaMemoProgram || len(ix.Parsed) == 0 {
			continue
		}
		var text string
		if err := json.Unmarshal(ix.Parsed, &text); err != nil {
			continue
		}
		var memo struct {
			IntentID string `json:"intentId"`
		}
		if err := json.Unmarshal([]byte(text), &memo); err != nil {
			continue
		}
		if id := strings.TrimSpace(memo.IntentID); id != "" {
			return id
		}
	}
	return ""
}

// mobulaCredited: the USDC that reached the solver, from the token balance
// deltas rather than from the transfer instruction's own amount.
//
// openchainbench-e9's point: the deposit transaction can carry the app's gas
// and other legs, so the figure has to be what the SOLVER received and not
// what the user's balance moved by.
func mobulaCredited(tx *parsedTx) float64 {
	pre := map[int]float64{}
	for _, b := range tx.Meta.PreTokenBalances {
		if b.Owner == mobulaSolver {
			pre[b.AccountIndex] = b.raw()
		}
	}
	best := 0.0
	for _, b := range tx.Meta.PostTokenBalances {
		if b.Owner != mobulaSolver {
			continue
		}
		d := b.raw() - pre[b.AccountIndex]
		if d != d || d <= 0 { // NaN from an unreadable amount, or no credit
			continue
		}
		if v := d / pow10(b.UITokenAmount.Decimals); v > best {
			best = v
		}
	}
	return best
}

// mobulaDepositor: the signer whose balance paid, which is the user rather
// than the app's gas sponsor. The sponsor is the FEE payer and is index 0; the
// user is the other signer.
func mobulaDepositor(tx *parsedTx) string {
	keys := tx.Transaction.Message.AccountKeys
	for i, k := range keys {
		if i == 0 || !k.Signer {
			continue
		}
		return k.Pubkey
	}
	// Measured: 44 distinct senders in 50 deposits, so the depositor is
	// normally a per-user wallet. When only the sponsor signed, the user is
	// whoever the token account that paid belongs to, and that needs a
	// lookup this does not do; "" is returned rather than naming the
	// sponsor as the user, which is the mistake #3217 had to undo.
	return ""
}

func pow10(n int) float64 {
	v := 1.0
	for i := 0; i < n; i++ {
		v *= 10
	}
	return v
}
