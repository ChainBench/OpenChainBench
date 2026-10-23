package main

// The poller that feeds the deposit decoder.
//
// It walks the bridge program's recent signatures, reads each transaction, and
// decodes the deposit event out of the inner instruction Anchor's emit_cpi!
// writes it into. Everything it needs already existed: rpcClient.signatures,
// rpcClient.transaction and base58Decode.
//
// Why a cursor and not a window. The program's traffic is mostly AdminDebit
// payouts, so a fixed lookback would re-read the same payouts every tick to
// find a handful of deposits. The cursor asks only for what arrived since last
// time, which is also what keeps the RPC cost of this flat as the bridge grows.
//
// Why this publishes sizes and not a fee. The deposit states its amount; what
// pump keeps is the difference between that and what an EVM router later
// spends, and the two legs cannot be paired because the destination is
// encrypted. The size distribution is what the deposit itself supports, and it
// is also what the fee schedule is read from: the spends that sit just under
// round numbers are the calibration, and knowing the deposit sizes is what says
// whether those round numbers are representative or a corner of the traffic.

import (
	"context"
	"log"
	"math"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	gPumpBridgeUp = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "tfq_pump_bridge_feed_up",
		Help: "1 when the Pump Bridge deposit poller read the program on its last pass. Separate from tfq_relay_feed_up: pump moved its cross-chain flow off Relay on 2026-10-07, so one feed being healthy says nothing about the other",
	})
	cPumpBridgeDeposits = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "tfq_pump_bridge_deposits_total",
		Help: "Deposits decoded from pump.fun's bridge program since this process started",
	})
	hPumpBridgeDeposit = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "tfq_pump_bridge_deposit_usd",
		Help:    "Size of each Pump Bridge deposit in USDC. The fee pump takes is NOT in here: it is deducted between this deposit and the EVM router's spend. The two legs CAN now be paired, on the order id both events carry, which is what tfq_pump_bridge_order_total measures",
		Buckets: []float64{1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 10000},
	})
	cPumpPayouts = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "tfq_pump_bridge_payouts_total",
		Help: "Payout events decoded from pump.fun's bridge program since this process started. A payout is the Solana leg of a SALE, and the feed used to drop it unread as an admin call, which is why a sale had no destination leg and was published as nothing",
	})
	cPumpOrder = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_pump_bridge_order_total",
		Help: "Attempts to join an EVM leg to its Solana leg on the ORDER ID both carry, by outcome. joined = the id named a delivery we hold. no_id = the EVM event carried no id, so this leg cannot be joined at all and the fault is in our decode. not_held = the id is good but no matching Solana leg is in the window, which is the feed being behind or the delivery not having happened yet. Published so the share that cannot be joined is MEASURED rather than assumed: the id matched 23 of 23 by hand on 2026-10-23, and this is what says whether that holds in production",
	}, []string{"chain", "side", "result"})
)

func init() {
	prometheus.MustRegister(gPumpBridgeUp, cPumpBridgeDeposits, hPumpBridgeDeposit, gPumpBridgeBehind, cPumpBridgeRead, cPumpPayouts, cPumpOrder)
}

// pumpBridgeFeed walks the bridge program forward from where it stopped.
type pumpBridgeFeed struct {
	cursor string // newest signature already read; "" on the first pass
	// retry holds signatures whose transaction could not be read, with the
	// unix time of the first failure. The cursor moves past them anyway, so
	// without this a failed read was a deposit lost for good: 2.4 % of reads
	// on QuickNode on 2026-10-22 (72 of 2,982), invisible to feed_behind.
	retry map[string]int64
}

// pumpBridgeRetryMax and pumpBridgeRetryAge bound the retry queue by count and
// by age, so a signature that is genuinely unreadable is abandoned rather than
// retried forever. Ten minutes is well inside the 30-minute deposit window, so
// a recovered deposit can still pair.
const (
	pumpBridgeRetryMax = 500
	pumpBridgeRetryAge = 10 * 60 // seconds
)

var cPumpBridgeRead = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "tfq_pump_bridge_tx_read_failed_total",
	Help: "Pump Bridge program transactions whose read failed, by what became of them: queued (kept for the next pass), recovered (read on a retry), abandoned (still unreadable after 10 minutes), dropped (retry queue full, lost at once). queued minus recovered is the deposits the pairing could not see",
}, []string{"outcome"})

// pumpBridgePageSize caps one pass. The program runs roughly 25,000 signatures
// a day, so a 60 second tick sees about 17; 200 leaves room for a slow tick or
// a burst without ever walking the whole history.
const pumpBridgePageSize = 400

// pumpBridgeFull: a pass that comes back full means the page was the limit,
// not the chain, so deposits older than it were skipped and the cursor moved
// past them anyway. Published because that loss is otherwise invisible: the
// pairing read 580 spends against a window missing most of its deposits and
// reported "no deposit found" 580 times, which looks like the method failing.
var gPumpBridgeBehind = prometheus.NewGauge(prometheus.GaugeOpts{
	Name: "tfq_pump_bridge_feed_behind",
	Help: "1 when the last deposit pass filled its page, meaning the program produced more signatures than one pass reads and some deposits were skipped. The pairing cannot find what the feed never saw, so this is the first thing to check when pairs go to zero",
})

// poll reads what arrived since the last pass and publishes the deposits in it.
//
// A pass that finds no deposits is normal and is not a failure: most of this
// program's traffic is payouts. Only an RPC error pulls the feed gauge down,
// because that is the state where a reader must not take a quiet row for a
// quiet bridge.
func (f *pumpBridgeFeed) poll(ctx context.Context, rpc *rpcClient) {
	hadCursor := f.cursor != ""
	sigs, err := rpc.signatures(ctx, pumpBridgeProgram, pumpBridgePageSize, f.cursor)
	if err != nil {
		gPumpBridgeUp.Set(0)
		log.Printf("[pump-bridge] signatures: %v", err)
		return
	}
	gPumpBridgeUp.Set(1)
	if len(sigs) == 0 {
		return
	}
	// signatures come back newest first; the newest becomes the next cursor
	// even if nothing in this page decodes, or a page of pure payouts would
	// be re-read forever.
	newest := sigs[0].Signature

	now := time.Now().Unix()
	deposits, scanned, failed, dropped := 0, 0, 0, 0
	for _, s := range sigs {
		if ctx.Err() != nil {
			break
		}
		if s.failed() {
			continue
		}
		d, ok := f.read(ctx, rpc, s.Signature)
		if !ok {
			failed++
			if !f.queue(s.Signature, now) {
				dropped++
			}
			continue
		}
		scanned++
		deposits += d
	}
	recovered, abandoned := f.retryPass(ctx, rpc, now)
	f.cursor = newest
	// A full page means the chain outran this pass, but ONLY once a cursor
	// exists: the first pass has none and reads the most recent page by
	// definition, so it is always full and says nothing. Flagging it anyway
	// reported the feed as losing ground at every restart, and sent me
	// enlarging a page that already had 2.6x the headroom it needed (the
	// program runs about 154 signatures a minute against 400 read).
	if hadCursor && len(sigs) >= pumpBridgePageSize {
		gPumpBridgeBehind.Set(1)
		log.Printf("[pump-bridge] page full (%d) with a cursor set: the program is producing faster than one pass reads, deposits were skipped", len(sigs))
	} else {
		gPumpBridgeBehind.Set(0)
	}
	if deposits > 0 || failed > 0 || recovered > 0 || abandoned > 0 {
		log.Printf("[pump-bridge] %d deposits in %d transactions; reads failed %d (dropped %d), retries recovered %d, abandoned %d, waiting %d",
			deposits, scanned, failed, dropped, recovered, abandoned, len(f.retry))
	}
}

// read fetches one transaction and publishes the deposits in it. ok is false
// when the transaction could not be read (an RPC error, or not found at this
// commitment), which is a gap to retry, not an empty transaction.
func (f *pumpBridgeFeed) read(ctx context.Context, rpc *rpcClient, sig string) (deposits int, ok bool) {
	tx, err := rpc.transaction(ctx, sig)
	if err != nil || tx == nil {
		return 0, false
	}
	for _, grp := range tx.Meta.InnerInstructions {
		for _, ix := range grp.Instructions {
			if ix.ProgramID != pumpBridgeProgram || ix.Data == "" {
				continue
			}
			raw, ok := base58Decode(ix.Data)
			if !ok {
				continue
			}
			d, err := decodePumpDeposit(raw)
			if err != nil {
				// A payout is the Solana leg of a SALE, and it carries the
				// order id and the amount delivered. This branch used to drop
				// it as "a payout or an admin call, which is the norm", and
				// that is why a sale had no destination leg to price against.
				if p, perr := decodePumpPayout(raw); perr == nil {
					cPumpPayouts.Inc()
					if tx.BlockTime != nil {
						pumpNotePayout(*tx.BlockTime, p.Order, float64(p.Amount)/1e6, p.User)
					}
				}
				continue // an admin call, which is the rest of the traffic
			}
			deposits++
			cPumpBridgeDeposits.Inc()
			amt := float64(d.Amount) / 1e6
			hPumpBridgeDeposit.Observe(amt)
			// Kept so the EVM side can find this deposit again. The
			// destination is encrypted, but the schedule inverts, so the
			// amount is the join key and the time is what it buys: how
			// long the bridge took to settle it.
			if tx.BlockTime != nil {
				pumpNoteDeposit(*tx.BlockTime, amt)
			}
		}
	}
	return deposits, true
}

// queue keeps a failed signature for the next pass. It returns false when the
// queue is full and the signature is lost at once, which is counted apart so
// a sustained outage reads as one rather than as a quiet bridge.
func (f *pumpBridgeFeed) queue(sig string, now int64) bool {
	if f.retry == nil {
		f.retry = map[string]int64{}
	}
	if _, ok := f.retry[sig]; ok {
		return true
	}
	if len(f.retry) >= pumpBridgeRetryMax {
		cPumpBridgeRead.WithLabelValues("dropped").Inc()
		return false
	}
	f.retry[sig] = now
	cPumpBridgeRead.WithLabelValues("queued").Inc()
	return true
}

// retryPass re-reads what earlier passes could not, skipping anything this
// pass just queued (it failed seconds ago and gets its turn next time).
func (f *pumpBridgeFeed) retryPass(ctx context.Context, rpc *rpcClient, now int64) (recovered, abandoned int) {
	for sig, since := range f.retry {
		if ctx.Err() != nil {
			return
		}
		if since == now {
			continue
		}
		if _, ok := f.read(ctx, rpc, sig); ok {
			delete(f.retry, sig)
			recovered++
			cPumpBridgeRead.WithLabelValues("recovered").Inc()
			continue
		}
		if now-since > pumpBridgeRetryAge {
			delete(f.retry, sig)
			abandoned++
			cPumpBridgeRead.WithLabelValues("abandoned").Inc()
		}
	}
	return
}

// run polls on its own cadence, slower than the swap tick: the bridge's
// deposits are a size distribution rather than a live price, and every pass
// costs one signatures call plus one transaction read per signature.
func (f *pumpBridgeFeed) run(ctx context.Context, rpc *rpcClient, every time.Duration) {
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

// pumpDep: one decoded deposit, kept only long enough to find its spend.
type pumpDep struct {
	at     int64 // unix seconds, Solana blockTime
	amount float64
}

// pumpDepWindow: the deposits seen recently, so a router spend on the EVM side
// can find the one that produced it.
//
// The feed already decodes these and then kept only a histogram. Holding the
// amounts is what makes the two sides joinable: the destination is encrypted,
// but the schedule inverts, so the amount is the key.
//
// Bounded by count and age: a spend that has not appeared within the window
// never will, and an unbounded slice would grow for the life of the process.
var pumpDepWindow struct {
	sync.Mutex
	seen []pumpDep
}

const (
	pumpDepWindowMax = 4000
	pumpDepWindowAge = 30 * 60 // seconds
)

// pumpSaveDeposits and pumpLoadDeposits carry the window across a restart.
//
// Without them every deploy empties the window, and since the spend watcher
// backfills far more chain than the deposit feed's first pass, the pairing
// then reads a full hour of spends it can never match: measured at 174
// spends, all none_blind, no settlement series at all. The column Florent
// asks about goes blank on every deploy, and this bench is deployed often.
//
// Load applies the same age prune as a live deposit, so a long outage expires
// the window on the existing rule instead of resurrecting stale deposits.
// pumpDepRecord is pumpDep with exported fields, which is the whole reason it
// exists: encoding/json ignores unexported ones, so persisting pumpDep
// directly would have written a list of empty objects. The window would have
// come back with every at=0, the age filter would have dropped the lot, and
// the result would be identical to having no fix at all while looking applied.
type pumpDepRecord struct {
	At     int64   `json:"at"`
	Amount float64 `json:"amount"`
}

func pumpSaveDeposits() []pumpDepRecord {
	pumpDepWindow.Lock()
	defer pumpDepWindow.Unlock()
	out := make([]pumpDepRecord, 0, len(pumpDepWindow.seen))
	for _, d := range pumpDepWindow.seen {
		out = append(out, pumpDepRecord{At: d.at, Amount: d.amount})
	}
	return out
}

func pumpLoadDeposits(seen []pumpDepRecord, now int64) int {
	if len(seen) == 0 {
		return 0
	}
	kept := make([]pumpDep, 0, len(seen))
	for _, d := range seen {
		if d.At <= 0 || d.Amount <= 0 || now-d.At > pumpDepWindowAge {
			continue
		}
		kept = append(kept, pumpDep{at: d.At, amount: d.Amount})
	}
	if len(kept) > pumpDepWindowMax {
		kept = kept[len(kept)-pumpDepWindowMax:]
	}
	pumpDepWindow.Lock()
	pumpDepWindow.seen = kept
	pumpDepWindow.Unlock()
	return len(kept)
}

// pumpNoteDeposit records a deposit for later pairing.
//
// The age prune walks from index 0 and stops at the first entry still inside
// the window, which reads as if the slice were ascending. It is not: poll()
// walks signatures newest first, so each pass inserts descending. What saves
// it is that each pass holds only signatures newer than the previous cursor,
// so the slice is ascending BY PASS and the prune drops whole passes at a
// time. The window therefore reaches back pumpDepWindowAge plus one pass
// width, about a minute in steady state and about three on the first pass,
// rather than the flat 30 minutes the constant suggests.
func pumpNoteDeposit(at int64, amount float64) {
	if at <= 0 || amount <= 0 {
		return
	}
	pumpDepWindow.Lock()
	defer pumpDepWindow.Unlock()
	w := append(pumpDepWindow.seen, pumpDep{at: at, amount: amount})
	cut := at - pumpDepWindowAge
	i := 0
	for i < len(w) && w[i].at < cut {
		i++
	}
	w = w[i:]
	if len(w) > pumpDepWindowMax {
		w = w[len(w)-pumpDepWindowMax:]
	}
	pumpDepWindow.seen = w
}

// pumpPayoutWindow: deliveries seen recently, keyed by the order id so the EVM
// leg of a sale can read what the user actually received.
//
// A map, not a slice, and that difference is the point. pumpDepWindow is a
// slice scanned for an amount within a time window, which is why it has an
// ambiguous case, a maxLag to argue about, and a tail that grew when the window
// widened. An order id admits exactly one answer or none.
//
// Bounded by age the same way, because a payout nobody claims must not be held
// for the life of the process. The age is generous on purpose: unlike the
// amount pairing, a wide window here costs nothing, since a wrong id cannot
// match. The only thing age protects is memory.
var pumpPayoutWindow struct {
	sync.Mutex
	by map[string]pumpPay
}

// pumpPay is one delivery: when it landed and how much arrived.
type pumpPay struct {
	at     int64
	amount float64
	user   string
}

const (
	pumpPayWindowMax = 20000
	pumpPayWindowAge = 2 * 60 * 60 // seconds
)

// pumpNotePayout records one delivery under its order id.
func pumpNotePayout(at int64, order string, amount float64, user string) {
	if at <= 0 || order == "" || amount <= 0 {
		return
	}
	pumpPayoutWindow.Lock()
	defer pumpPayoutWindow.Unlock()
	if pumpPayoutWindow.by == nil {
		pumpPayoutWindow.by = map[string]pumpPay{}
	}
	pumpPayoutWindow.by[order] = pumpPay{at: at, amount: amount, user: user}
	// Prune only when the map has grown, so the common path is one insert.
	if len(pumpPayoutWindow.by) <= pumpPayWindowMax {
		return
	}
	cut := at - pumpPayWindowAge
	for k, v := range pumpPayoutWindow.by {
		if v.at < cut {
			delete(pumpPayoutWindow.by, k)
		}
	}
}

// pumpFindPayout returns the delivery for an order id.
//
// There is no tolerance and no second candidate by construction: the id either
// names a delivery we hold or it does not. A miss is a miss and the caller must
// publish nothing from it, which is the difference between this and the amount
// pairing it replaces.
func pumpFindPayout(order string) (pumpPay, bool) {
	if order == "" {
		return pumpPay{}, false
	}
	pumpPayoutWindow.Lock()
	defer pumpPayoutWindow.Unlock()
	p, ok := pumpPayoutWindow.by[order]
	return p, ok
}

// pumpFindDeposit returns the deposit that produced this spend, and whether
// exactly one candidate matched.
//
// Ambiguity is reported as a miss rather than guessed at: two users depositing
// the same round amount in the same minute is common, and picking one would
// invent a latency. The share of spends that pair uniquely is published beside
// the latency so the base is visible.
// pumpFindDeposit returns the match and, as inRange, how many deposits were in
// the lag range at all.
//
// inRange is what separates a miss from a blind spot. The window is in memory,
// ages out at 30 minutes plus one pass (see pumpNoteDeposit: pruning walks
// whole passes, so about a minute of slack in steady state and about three
// on the first pass) and starts EMPTY after every restart, so a search
// against an empty range could not have succeeded whatever the bridge did.
// Without this, that case is counted as "none" beside genuine misses and a
// failure rate built on it would publish our own restarts as pump's
// reliability.
// pumpOldestDeposit: the timestamp of the oldest deposit held, or 0 when the
// window is empty.
//
// A spend older than this could never pair, whatever the bridge did, because
// its deposit happened before anything we hold. That is the normal state for
// the first stretch after a restart, when the spend watcher backfills far more
// chain than the deposit feed's first pass covers.
func pumpOldestDeposit() int64 {
	pumpDepWindow.Lock()
	defer pumpDepWindow.Unlock()
	oldest := int64(0)
	for _, d := range pumpDepWindow.seen {
		if oldest == 0 || d.at < oldest {
			oldest = d.at
		}
	}
	return oldest
}

func pumpFindDeposit(want float64, spentAt int64, maxLag int64) (pumpDep, string, int) {
	pumpDepWindow.Lock()
	defer pumpDepWindow.Unlock()
	var hit pumpDep
	n, inRange := 0, 0
	for _, d := range pumpDepWindow.seen {
		if d.at > spentAt || spentAt-d.at > maxLag {
			continue
		}
		inRange++
		// Exact to the token's precision: these are integer amounts read from
		// the chain on both sides, so a near miss is a different deposit.
		if math.Abs(d.amount-want) > 1e-6 {
			continue
		}
		n++
		if n > 1 {
			// Several users sent the same amount in the window. Reported as
			// its own outcome, not folded into "none": the two call for
			// opposite fixes, a shorter window against a longer one, and
			// conflating them hides which.
			return pumpDep{}, "ambiguous", inRange
		}
		hit = d
	}
	if n == 1 {
		return hit, "unique", inRange
	}
	return pumpDep{}, "none", inRange
}
