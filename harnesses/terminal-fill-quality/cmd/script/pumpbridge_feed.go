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
		Help:    "Size of each Pump Bridge deposit in USDC. The fee pump takes is NOT in here: it is deducted between this deposit and the EVM router's spend, and the two legs cannot be paired because the destination is encrypted on chain",
		Buckets: []float64{1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 10000},
	})
)

func init() {
	prometheus.MustRegister(gPumpBridgeUp, cPumpBridgeDeposits, hPumpBridgeDeposit, gPumpBridgeBehind)
}

// pumpBridgeFeed walks the bridge program forward from where it stopped.
type pumpBridgeFeed struct {
	cursor string // newest signature already read; "" on the first pass
}

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

	deposits, scanned := 0, 0
	for _, s := range sigs {
		if ctx.Err() != nil {
			break
		}
		if s.failed() {
			continue
		}
		tx, err := rpc.transaction(ctx, s.Signature)
		if err != nil || tx == nil {
			continue
		}
		scanned++
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
					continue // a payout or an admin call, which is the norm
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
	}
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
	if deposits > 0 {
		log.Printf("[pump-bridge] %d deposits in %d transactions", deposits, scanned)
	}
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

// pumpNoteDeposit records a deposit for later pairing.
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

// pumpFindDeposit returns the deposit that produced this spend, and whether
// exactly one candidate matched.
//
// Ambiguity is reported as a miss rather than guessed at: two users depositing
// the same round amount in the same minute is common, and picking one would
// invent a latency. The share of spends that pair uniquely is published beside
// the latency so the base is visible.
func pumpFindDeposit(want float64, spentAt int64, maxLag int64) (pumpDep, string) {
	pumpDepWindow.Lock()
	defer pumpDepWindow.Unlock()
	var hit pumpDep
	n := 0
	for _, d := range pumpDepWindow.seen {
		if d.at > spentAt || spentAt-d.at > maxLag {
			continue
		}
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
			return pumpDep{}, "ambiguous"
		}
		hit = d
	}
	if n == 1 {
		return hit, "unique"
	}
	return pumpDep{}, "none"
}
