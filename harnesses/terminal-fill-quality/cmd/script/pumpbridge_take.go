package main

// What pump.fun's bridge keeps, read off the EVM routers.
//
// The deposit decoder in pumpbridge_feed.go says what a user put in on Solana.
// The EVM router later spends a stable to buy the token. The fee is taken in
// between, and the two legs cannot be paired because the destination is
// encrypted on chain.
//
// They do not need to be paired. Users type round amounts, so the router's
// spend is a round amount minus the fee, and the fee alone identifies the
// schedule:
//
//	9.905000 of 10   take 0.095000 = 0.05 + 0.0045*10
//	9.910000 of 10   take 0.090000 = 0.05 + 0.0040*10
//	0.946000 of 1    take 0.054000 = 0.05 + 0.0040*1
//
// Two rates run, 40 and 45 bps, over the same 0.05 fixed component, and the mix
// differs by chain. Neither parameter is assumed: on the 40 bps population the
// takes at levels 1, 2, 3, 5 and 10 are 0.054, 0.058, 0.062, 0.070 and 0.090,
// whose slope is exactly 0.004 per unit and whose intercept is exactly 0.050,
// with no residual at any of the five levels.
//
// Why the test is on the rate and not on the roundness: a window around round
// numbers admits almost everything (a 9.5% window matched 48% of spends against
// a 21 to 32% chance rate, with contradictory takes at the same level, measured
// 2026-10-22). Requiring the implied rate to land exactly on the grid matched
// 20 to 25% of spends while the same test with the level grid shifted 7% matched
// 0.0% on all three chains. That separation is the measurement.
//
// Arithmetic is integer, in raw token units, so a match is exact equality and
// there is no tolerance to tune.

import (
	"context"
	"log"
	"math"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	cPumpSpends = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_pump_bridge_spends_total",
		Help: "Stable spends seen leaving a pump.fun bridge router, split by whether the fee could be read back exactly. The unmatched ones are trades whose size was not a round number, not errors; the ratio is the base this measurement rests on",
	}, []string{"chain", "matched"})
	cPumpSchedule = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_pump_bridge_schedule_total",
		Help: "Spends whose fee equals 0.05 plus this many basis points of a round trade size, exactly, in integer token units. Two rates run (40 and 45) and the mix differs by chain. A new label value, or matched spends falling to zero while unmatched stays high, is pump changing the schedule",
	}, []string{"chain", "bps"})
	hPumpTakeBps = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "tfq_pump_bridge_take_bps",
		Help:    "What the bridge kept on a spend whose size could be read back, as a share of that size in basis points. Size dependent because the schedule has a fixed component, so read the distribution rather than an average: the same 45 bps schedule costs 545 bps on a $1 trade and 50 on a $100 one",
		Buckets: []float64{45, 50, 60, 80, 100, 150, 200, 300, 500, 600},
	}, []string{"chain"})
)

func init() {
	prometheus.MustRegister(cPumpSpends, cPumpSchedule, hPumpTakeBps)
}

// pumpLevels: the trade sizes a person types, in whole stable units. The grid is
// what makes the test falsifiable, so it stays short and plausible rather than
// dense: every extra level raises the chance of a coincidental match, and the
// shifted-grid null above is only meaningful because this list is not arbitrary.
var pumpLevels = []int64{
	1, 2, 3, 5, 10, 15, 20, 25, 30, 50, 75, 100, 150, 200, 250, 300,
	500, 750, 1000, 1500, 2000, 2500, 5000, 10000,
}

// pumpRatesBps: the rates observed on chain. Candidates, not an assumption: a
// spend matching none of them is counted unmatched, so if pump moves to a third
// rate the matched share collapses visibly instead of a wrong number being
// published.
var pumpRatesBps = []int64{40, 45}

// pumpFixedHundredths: the fixed component, 0.05 of a stable unit, held in
// hundredths so it scales to any token decimals by integer arithmetic.
const pumpFixedHundredths = 5

// pumpMatch reads one spend as a round trade size minus the bridge's fee.
//
// spent and the result are raw token units. The level tried is the smallest in
// the grid above the spend: a fee is a small deduction, so no other level can
// explain it.
//
// Returns the rate in basis points and the take as a share of the trade, or
// ok=false when no rate in the grid reproduces the gap exactly.
func pumpMatch(spent *big.Int, dec int) (bps int64, takeBps float64, ok bool) {
	if spent == nil || spent.Sign() <= 0 || dec < 2 {
		return 0, 0, false
	}
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dec)), nil)
	// 0.05 in raw units: 5 * 10^(dec-2), exact for every dec >= 2.
	fixed := new(big.Int).Mul(big.NewInt(pumpFixedHundredths),
		new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dec-2)), nil))

	for _, lv := range pumpLevels {
		level := new(big.Int).Mul(big.NewInt(lv), scale)
		if level.Cmp(spent) <= 0 {
			continue // this level is at or below the spend; try a larger one
		}
		gap := new(big.Int).Sub(level, spent)
		if gap.Cmp(fixed) <= 0 {
			// The fixed component alone already exceeds the gap, so no rate can
			// fit, and no larger level can either: its gap is only bigger while
			// the test needs it to land exactly.
			return 0, 0, false
		}
		for _, r := range pumpRatesBps {
			// want = fixed + level * r / 10000, integer for every level and dec
			// used here, so the comparison below is exact.
			want := new(big.Int).Mul(level, big.NewInt(r))
			want.Quo(want, big.NewInt(10000))
			want.Add(want, fixed)
			if want.Cmp(gap) == 0 {
				gf, _ := new(big.Float).SetInt(gap).Float64()
				lf, _ := new(big.Float).SetInt(level).Float64()
				if lf <= 0 {
					return 0, 0, false
				}
				return r, 10000 * gf / lf, true
			}
		}
		// The smallest level above the spend is the only candidate: a fee is a
		// deduction from the size the user chose, not from a larger round number.
		return 0, 0, false
	}
	return 0, 0, false
}

// observePumpSpend records one spend and, when the schedule explains it, the fee.
func observePumpSpend(chain string, spent *big.Int, dec int) {
	bps, takeBps, ok := pumpMatch(spent, dec)
	if !ok {
		cPumpSpends.WithLabelValues(chain, "no").Inc()
		return
	}
	cPumpSpends.WithLabelValues(chain, "yes").Inc()
	cPumpSchedule.WithLabelValues(chain, big.NewInt(bps).String()).Inc()
	hPumpTakeBps.WithLabelValues(chain).Observe(takeBps)
	// Kept in process as well as in Prometheus: the gross-up needs the rate
	// the chain actually showed, and reading it back out of a counter would
	// make a published figure depend on a scrape.
	pumpSeen.Lock()
	if pumpSeen.byChain == nil {
		pumpSeen.byChain = map[string]map[int64]int{}
	}
	if pumpSeen.byChain[chain] == nil {
		pumpSeen.byChain[chain] = map[int64]int{}
	}
	pumpSeen.byChain[chain][bps]++
	pumpSeen.Unlock()
}

// pumpRouter: where to read the spends, one row per chain carrying a router.
//
// The settlement token is named, never discovered: the token a router transfers
// most is the memecoin being bought, not the stable it pays with, and taking
// that one rescales every figure by the wrong decimals. Confirmed by reading the
// symbols out of each router's own transfers (Robinhood Chain sends PONS 476
// times and CASHCAT 475 against USDG 90).
type pumpRouter struct {
	chain    string
	router   string
	token    string
	symbol   string // what the token's own symbol() returns, for the reader
	decimals int
}

var pumpRouters = []pumpRouter{
	{"bnb", "0x836b336fca26913176efc45a5a6e5e72cd7bd13b",
		"0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "BSC-USD", 18},
	{"base", "0x836b336fca26913176efc45a5a6e5e72cd7bd13b",
		"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "USDC", 6},
	{"robinhood", "0x5399d94d2cab7c252a6034042e1917a0e5e17a18",
		"0x5fc5360d0400a0fd4f2af552add042d716f1d168", "USDG", 6},
}

// topicERC20Transfer: Transfer(address,address,uint256).
const topicERC20Transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

// pumpTakeWatcher walks each router forward from where it stopped.
type pumpTakeWatcher struct {
	cursor map[string]int64
}

func newPumpTakeWatcher() *pumpTakeWatcher {
	return &pumpTakeWatcher{cursor: map[string]int64{}}
}

// run polls slowly: this measures a fee schedule, which changes on the scale of
// a product decision rather than a block, and each pass is one getLogs per chain.
func (w *pumpTakeWatcher) run(ctx context.Context, httpc *http.Client, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	w.poll(ctx, httpc)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.poll(ctx, httpc)
		}
	}
}

func (w *pumpTakeWatcher) poll(ctx context.Context, httpc *http.Client) {
	for _, r := range pumpRouters {
		var c originChain
		found := false
		for _, oc := range originChains {
			if oc.slug == r.chain {
				c, found = oc, true
				break
			}
		}
		if !found {
			continue
		}
		var headHex string
		if err := evmCall(ctx, httpc, c.rpc, "eth_blockNumber", []any{}, &headHex); err != nil {
			continue
		}
		head := hexInt(headHex)
		span := c.logsSpan()
		// A fresh cursor starts one span back, not at genesis: this is a running
		// measurement of a live schedule, and a cursor at zero would never catch
		// up. A cursor left far behind (a restart after a long stop) is moved up
		// for the same reason.
		from := w.cursor[r.chain]
		if from == 0 || head-from > 4*span {
			from = head - span
		}
		if from < 0 {
			from = 0
		}
		to := min64(head, from+span)
		if to <= from {
			continue
		}
		var logs []evmLog
		err := evmCall(ctx, httpc, c.logsRPC(), "eth_getLogs", []any{map[string]any{
			"fromBlock": "0x" + big.NewInt(from).Text(16),
			"toBlock":   "0x" + big.NewInt(to).Text(16),
			"address":   r.token,
			"topics":    []any{topicERC20Transfer, "0x" + strings.Repeat("0", 24) + strings.TrimPrefix(r.router, "0x")},
		}}, &logs)
		if err != nil && !strings.Contains(err.Error(), "empty result") {
			// The cursor is NOT advanced: a refused read is a gap to retry, not a
			// quiet range. Advancing here would drop the window silently, which is
			// the bug that left the native feed polling the same blocks.
			log.Printf("[pump-take] %s: %s", r.chain, redactURL(err.Error(), c.logsRPC()[0]))
			continue
		}
		// One spend per transaction. Measured on 2026-10-22, 83 of 85 Robinhood
		// transactions carry a single outgoing stable transfer, so summing the
		// legs of the rare multi-leg route is what the user actually paid.
		perTx := map[string]*big.Int{}
		order := []string{}
		for _, l := range logs {
			v := word(l.Data, 0)
			if v.Sign() <= 0 {
				continue
			}
			if cur, ok := perTx[l.TxHash]; ok {
				cur.Add(cur, v)
				continue
			}
			perTx[l.TxHash] = new(big.Int).Set(v)
			order = append(order, l.TxHash)
		}
		for _, tx := range order {
			observePumpSpend(r.chain, perTx[tx], r.decimals)
		}
		// to+1, not to: eth_getLogs includes both bounds, so leaving the
		// cursor on `to` reads that block again next pass and counts its
		// spends twice in the schedule counter. Found by audit 2026-10-22.
		w.cursor[r.chain] = to + 1
		if len(order) > 0 {
			log.Printf("[pump-take] %s: %d spends in %s over blocks %d-%d",
				r.chain, len(order), r.symbol, from, to)
		}
	}
}

// pumpBridgeRow: whether this row reads a Pump Bridge router.
//
// Such a row measures the destination swap alone. What the bridge keeps is
// taken on the Solana deposit, before the router spends anything, and is
// published by this file's own metrics instead.
func pumpBridgeRow(slug string) bool {
	for _, t := range evmTerminals {
		if t.Slug != slug {
			continue
		}
		for _, router := range t.Routers {
			for _, known := range pumpRouters {
				if strings.EqualFold(router, known.router) {
					return true
				}
			}
		}
	}
	return false
}

// The schedule, as the gross-up applies it.
//
// pumpRatesBps holds the two rates the chain shows, 40 and 45. Which one a
// given swap paid is not knowable unless its size reads back to a round level,
// which 7 of 40 do. The midpoint is used for the rest because the two rates sit
// 5 bps apart while the deduction itself runs 45 to 545 bps: the residual is
// 2.51 bps and symmetric, against 45 to 545 one-signed if it is ignored.
const (
	pumpFixedUSD = 0.05
	// pumpFallbackRate: used only until a chain has shown enough exactly
	// readable spends to say what it charges there. It is the midpoint of the
	// two rates seen so far, a typed number, which is why it is a fallback
	// rather than the figure.
	pumpFallbackRate = 0.00425
	// pumpRateMinSeen: exact matches a chain must show before its own mix is
	// trusted over the fallback. Low because each match is exact equality in
	// integer units, not a fit.
	pumpRateMinSeen = 5
)

// pumpSeen: the rates each chain showed, from spends whose size read back to a
// round level exactly.
var pumpSeen struct {
	sync.Mutex
	byChain map[string]map[int64]int
}

// pumpChainRate: the rate to gross up with on this chain, weighted by how often
// each rate was matched there.
//
// The mix is not the same everywhere: BNB leaned 45 bps (14 against 9) while
// Robinhood Chain leaned 40 (40 against 8) on 2026-10-22, so one typed constant
// everywhere costs up to 1.7 bps on Robinhood. A chain with too few matches
// falls back, and the matched share is published beside the figure so a rate
// that stops being confirmed stays visible.
func pumpChainRate(chain string) float64 {
	pumpSeen.Lock()
	defer pumpSeen.Unlock()
	total, weighted := 0, int64(0)
	for bps, n := range pumpSeen.byChain[chain] {
		total += n
		weighted += bps * int64(n)
	}
	if total < pumpRateMinSeen {
		return pumpFallbackRate
	}
	return float64(weighted) / float64(total) / 10000.0
}

// pumpChainOf: the chain a pump row reads, for looking up its observed rate.
func pumpChainOf(slug string) string {
	for _, t := range evmTerminals {
		if t.Slug == slug {
			return t.Chain
		}
	}
	return ""
}

// pumpGrossUpCap bounds the correction. A spend the schedule cannot plausibly
// explain is left alone rather than inflated: at $1 the deduction is already
// 9.5% of the trade, so anything past 20% is not this fee.
const pumpGrossUpCap = 1.20

// pumpGrossUp returns what the user meant to spend, given what the router
// spent, and whether the correction was applied.
//
// The router is pre-funded, so the user's input is not in the EVM transaction:
// only 4 of 40 swaps read on 2026-10-22 saw a stable arrive, none of them a
// round amount. Inverting the schedule recovers it without pairing anything.
func pumpGrossUp(slug string, spentUSD float64) (float64, bool) {
	return pumpGrossUpFunded(slug, spentUSD, false)
}

// pumpGrossUpFunded is pumpGrossUp with the funding test the caller can make.
//
// userFunded means something arrived at the router in this transaction, so the
// sender paid for the trade here and the spend is already what they committed.
// Grossing that up adds a deduction nobody charged: about 62 bps at $25 and
// 142 bps at $5, in the direction that makes the product look dearer.
//
// 4 of 40 swaps read on 2026-10-22 looked like that. The other 36 saw nothing
// arrive, which is what a pre-funded router looks like.
func pumpGrossUpFunded(slug string, spentUSD float64, userFunded bool) (float64, bool) {
	if userFunded {
		return spentUSD, false
	}
	if !pumpBridgeRow(slug) || spentUSD <= 0 || math.IsNaN(spentUSD) || math.IsInf(spentUSD, 0) {
		return spentUSD, false
	}
	gross := (spentUSD + pumpFixedUSD) / (1 - pumpChainRate(pumpChainOf(slug)))
	if gross <= spentUSD || gross > spentUSD*pumpGrossUpCap {
		return spentUSD, false
	}
	return gross, true
}
