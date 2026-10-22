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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	cPumpSpends = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_pump_bridge_spends_total",
		Help: "Stable spends seen leaving a pump.fun bridge router, split by whether the implied trade size is one of the ROUND levels in pumpLevels. matched=no means the size was not round; it does NOT mean the spend is unpairable, because pairing inverts the schedule for any amount and only needs the deposit to exist. So paired can and does exceed matched=yes, by a factor of two on some chains, and neither counter bounds the other",
	}, []string{"chain", "matched"})
	cPumpSchedule = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_pump_bridge_schedule_total",
		Help: "Spends whose fee equals 0.05 plus this many basis points of a round trade size, exactly, in integer token units. Two rates run (40 and 45) and the mix differs by chain. A new label value, or matched spends falling to zero while unmatched stays high, is pump changing the schedule",
	}, []string{"chain", "bps"})
	hPumpSettle = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "tfq_pump_bridge_settle_seconds",
		Help:    "Seconds between a Solana deposit and the EVM router spending it, for the spends whose deposit can be identified by the amount the schedule implies. Read it with histogram_quantile, NEVER as sum/count: a few percent of pairs are stalls past 60 s and they drag the mean of a day's sample from a 0.37 s median to about 20 s (see tfq_pump_bridge_stall_total). This is the on-chain segment alone: pump's own figure is tap to notification and includes the app, the network and its queueing, so the two are not the same quantity. Read per chain, since block time differs (BNB 0.45 s, Robinhood Chain 0.10 s, Base 2.00 s). Absolute values also carry a cross-chain clock offset that is NOT corrected here: each chain stamps blocks on its own clock and Solana's offset to the EVM chains changed at the Alpenglow switch, so compare a chain with itself over time, not one chain against another",
		Buckets: []float64{0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 10, 20, 60, 300},
	}, []string{"chain"})
	gSettleMs = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_settle_ms",
		Help: "Cross-chain settlement time per route, milliseconds: the Solana deposit to the destination spend that consumed it, matched by the amount the fee schedule implies. RESOLUTION IS ONE SECOND, so values are multiples of 1000: both ends are block timestamps in whole seconds and intra-second block ordering is not used to refine them. Stalls past 60 s are excluded (counted in tfq_pump_bridge_stall_total) because a handful of them move a mean by more than an order of magnitude. stat=median|p90|mean|over10s_pct, the last being the share of settlements slower than ten seconds, published because a mean still carries everything under 60 s and two routes can differ on their tail rather than their typical speed. READ THE MEAN to compare routes: at one-second resolution a sample is 0, 1, 2 or 3 seconds, so a median can only take one of four values and two different routes sharing one carries no information. The mean is stall-free because anything past 60 s never enters the window",
	}, []string{"terminal", "chain", "stat"})
	gBridgeCostPct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "bridge_cost_percent_pump",
		Help: "What Pump Bridge's own schedule costs at a given notional, percent: (0.05 of the stable plus the chain's measured rate times the notional) over the notional. Published for bench 003 beside the quote-based bridges, UNRANKED, because it is not the same product: those move USDC to USDC and this delivers a token, so the cost is comparable while the service is not. Gas on the destination is sponsored and the schedule is fixed, so this deduction is the whole cost of the bridging step rather than a fee with slippage omitted",
	}, []string{"amount_usd"})
	cPumpStall = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_pump_bridge_stall_total",
		Help: "Paired spends that took longer than 60 seconds to settle. Counted apart because they are what makes the settle histogram's mean useless: about 4% of pairs, enough to move a mean by more than an order of magnitude while leaving the median where it was. A rising share here is the bridge stalling, which the median will not show",
	}, []string{"chain"})
	cPumpPair = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_pump_bridge_pair_total",
		Help: "Router spends by whether their deposit could be identified. unique: one candidate. ambiguous: several users sent the same amount in the window. none_searched: deposits WERE in the lag range and none matched, the only outcome that can mean a failed bridge. none_blind: the window held nothing in range at all, so the search could not have succeeded whatever the bridge did, which is OUR blindness and must never be counted as a failure. The settle histogram covers unique only",
	}, []string{"chain", "result"})
	hPumpTakeBps = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "tfq_pump_bridge_take_bps",
		Help:    "What the bridge kept on a spend whose size could be read back, as a share of that size in basis points. Size dependent because the schedule has a fixed component, so read the distribution rather than an average: the same 45 bps schedule costs 545 bps on a $1 trade and 50 on a $100 one",
		Buckets: []float64{45, 50, 60, 80, 100, 150, 200, 300, 500, 600},
	}, []string{"chain"})
)

func init() {
	prometheus.MustRegister(cPumpSpends, cPumpSchedule, hPumpTakeBps, hPumpSettle, cPumpPair, cPumpStall, gSettleMs, gBridgeCostPct)
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
	// Feed the derivation first, from the population rather than from the
	// conclusions: pumpMatch applies a schedule, pumpNoteCandidate assumes none.
	if f, _ := new(big.Float).SetInt(spent).Float64(); f > 0 && dec >= 2 {
		pumpNoteCandidate(chain, f/math.Pow10(dec))
	}
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
	// The schedule-implied cost at the notionals bench 003 samples. Published
	// each pass so it tracks the rate the watcher derives rather than a
	// constant frozen at startup.
	defer pumpPublishBridgeCost()
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
		blockOf := map[string]int64{}
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
			blockOf[l.TxHash] = hexInt(l.BlockNumber)
			order = append(order, l.TxHash)
		}
		for _, tx := range order {
			observePumpSpend(r.chain, perTx[tx], r.decimals)
			pumpPairSpend(ctx, httpc, c, r, perTx[tx], blockOf[tx])
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

// pumpLooseShare: the only bound used to pick candidates for the derivation.
//
// A fee is a small deduction, so a spend sitting under a round level by less
// than a tenth might be one. This assumes no value, which is what lets the
// fixed component be derived rather than confirmed: 0.05 never touches the
// evidence it is derived from.
const pumpLooseShare = 0.10

// pumpDeriveMinPairs: agreeing pairs before a derived schedule is trusted.
const pumpDeriveMinPairs = 4

// pumpCand holds one candidate reading of a spend, with nothing assumed.
type pumpCand struct{ level, take float64 }

var pumpCands struct {
	sync.Mutex
	byChain map[string][]pumpCand
}

// pumpNoteCandidate records a spend as a possible fee reading.
//
// Called for every router spend, matched or not: the derivation needs the
// population, not the conclusions drawn from it.
func pumpNoteCandidate(chain string, spentUSD float64) {
	if spentUSD <= 0 || math.IsNaN(spentUSD) || math.IsInf(spentUSD, 0) {
		return
	}
	var level float64
	for _, lv := range pumpLevels {
		if float64(lv) > spentUSD {
			level = float64(lv)
			break
		}
	}
	if level == 0 {
		return
	}
	take := level - spentUSD
	if take <= 0 || take > level*pumpLooseShare {
		return
	}
	pumpCands.Lock()
	defer pumpCands.Unlock()
	if pumpCands.byChain == nil {
		pumpCands.byChain = map[string][]pumpCand{}
	}
	c := pumpCands.byChain[chain]
	// Bounded: the schedule is a constant, not a trend, so a few hundred
	// readings settle it and the rest would only grow the pair loop.
	if len(c) >= 400 {
		c = c[1:]
	}
	pumpCands.byChain[chain] = append(c, pumpCand{level, take})
}

// pumpDerivedFixed returns the fixed component this chain's own spends imply.
//
// Pairs at different levels each solve the schedule; the real ones agree and
// noise scatters, so the mode wins. Returns false until enough pairs agree, and
// the caller then falls back to the constant, which is why that constant is
// named a fallback.
func pumpDerivedFixed(chain string) (float64, bool) {
	pumpCands.Lock()
	cands := append([]pumpCand(nil), pumpCands.byChain[chain]...)
	pumpCands.Unlock()
	if len(cands) < 2 {
		return 0, false
	}
	votes := map[[2]int64]int{}
	for i := 0; i < len(cands); i++ {
		for j := i + 1; j < len(cands); j++ {
			a, b := cands[i], cands[j]
			if a.level == b.level {
				continue
			}
			r := (b.take - a.take) / (b.level - a.level)
			f := a.take - r*a.level
			if r <= 0 || r > 0.01 || f < 0 || f > 1 {
				continue
			}
			// Rounded to the precision the chain carries: a tenth of a basis
			// point on the rate, a hundredth of a cent on the fixed part.
			k := [2]int64{int64(math.Round(r * 100000)), int64(math.Round(f * 10000))}
			votes[k]++
		}
	}
	best, bestN := [2]int64{}, 0
	for k, n := range votes {
		if n > bestN {
			best, bestN = k, n
		}
	}
	if bestN < pumpDeriveMinPairs {
		return 0, false
	}
	return float64(best[1]) / 10000, true
}

// pumpFixed: the fixed component to use on this chain, derived when the chain
// has shown enough and the typed fallback until then.
func pumpFixed(chain string) float64 {
	if f, ok := pumpDerivedFixed(chain); ok {
		return f
	}
	return pumpFixedUSD
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
	// No declared settlement stable means the funding test cannot run on this
	// row, and grossing up without it would add a deduction to a trade the
	// sender may have funded here. pumpRouters names three chains; the rows on
	// Arc, MegaETH and X Layer wait for theirs to be read off the chain.
	if pumpStableOf(slug) == "" {
		return spentUSD, false
	}
	chain := pumpChainOf(slug)
	gross := (spentUSD + pumpFixed(chain)) / (1 - pumpChainRate(chain))
	if gross <= spentUSD || gross > spentUSD*pumpGrossUpCap {
		return spentUSD, false
	}
	return gross, true
}

// pumpSettleMaxLag: how long after a deposit its spend may appear and still be
// read as the same trade. Generous on purpose: the question is what the
// settlement time IS, so a tight window would cut the tail it is meant to show.
const pumpSettleMaxLag = 300

// pumpBlockTime caches block timestamps, which are read once per block rather
// than once per spend: several spends share a block on a busy router.
var pumpBlockTime struct {
	sync.Mutex
	at map[string]map[int64]int64
}

// pumpPairSpend finds the deposit behind one spend and records how long it took.
//
// The schedule inverts, so the deposit amount is known exactly; the deposit
// window holds what Solana saw. A spend matching several deposits is counted
// ambiguous rather than attributed, because two users sending the same round
// amount in the same minute is ordinary and picking one would invent a figure.
func pumpPairSpend(ctx context.Context, httpc *http.Client, c originChain, r pumpRouter, spent *big.Int, block int64) {
	if spent == nil || block <= 0 {
		return
	}
	sf, _ := new(big.Float).SetInt(spent).Float64()
	sf /= math.Pow10(r.decimals)
	if sf <= 0 {
		return
	}
	at := pumpBlockAt(ctx, httpc, c, r.chain, block)
	if at <= 0 {
		return
	}
	// Each rate is tried on its own, never the chain's weighted mix.
	//
	// That mix is right for grossing up a loss, where 2.5 bps of error is
	// nothing. It is fatal here: no trade ever paid 42.7 bps, each paid 40 or
	// 45, so a weighted implied amount misses the real deposit by thousands of
	// times the tolerance and NO spend can ever pair. 1014 of them did not.
	fixed := pumpFixed(r.chain)
	var dep pumpDep
	why := "none"
	sawAny := 0
	for _, bps := range pumpRatesBps {
		cand := (sf + fixed) / (1 - float64(bps)/10000)
		d, w, inRange := pumpFindDeposit(cand, at, pumpSettleMaxLag)
		if inRange > sawAny {
			sawAny = inRange
		}
		if w == "unique" {
			dep, why = d, "unique"
			break
		}
		if w == "ambiguous" {
			why = "ambiguous"
		}
	}
	// A miss against an EMPTY range is our blindness, not the bridge's: the
	// deposit window is in memory, ages out at 30 minutes and refills from
	// nothing after a restart. Counted apart so a failure rate can never be
	// built on it by accident.
	if why == "none" && sawAny == 0 {
		why = "none_blind"
	} else if why == "none" {
		why = "none_searched"
	}
	cPumpPair.WithLabelValues(r.chain, why).Inc()
	if why != "unique" {
		// ambiguous and none are kept apart because they mean opposite things:
		// ambiguous says the window is too wide for how many users send the
		// same round amount, none says the deposit is not there at all. One
		// is tuned away, the other is the method failing.
		return
	}
	took := float64(at - dep.at)
	hPumpSettle.WithLabelValues(r.chain).Observe(took)
	if took > 60 {
		cPumpStall.WithLabelValues(r.chain).Inc()
	}
	pumpNoteSettle(r.chain, took)
}

// pumpSettleWindow holds recent settlement times per chain so a median can be
// published. A histogram cannot give one back: its buckets would have to be
// read with histogram_quantile, and at one-second resolution that interpolates
// inside a bucket and invents precision the data does not have.
var pumpSettleWindow struct {
	sync.Mutex
	by map[string]map[string][]float64 // terminal -> chain -> seconds
}

const pumpSettleWindowMax = 2000

// pumpSettleMin: samples required before a quantile is published at all.
// The window is in memory and refills after a restart, so this is what stops
// a one-sample "median" reaching a page during the warm-up. Absent reads as
// "no data yet"; a number reads as fact.
const pumpSettleMin = 10

// pumpNoteSettle records one settlement and republishes the quantiles.
//
// Stalls past 60 s are left out, as Relay's own dashboard does, because they
// are a few percent of pairs and they move a mean by more than an order of
// magnitude while leaving the median where it was. They stay visible in
// tfq_pump_bridge_stall_total.
func pumpNoteSettle(chain string, took float64) {
	noteSettle("pump-bridge", chain, took)
}

// noteSettle records one route's settlement and republishes its quantiles.
//
// Terminal is the PRODUCT, so Pump Bridge and the Relay-carried routes land
// side by side under one metric and the page can compare them. Both are the
// same quantity, destination block time minus origin block time, which is the
// only reason putting them in one metric is honest.
func noteSettle(terminal, chain string, took float64) {
	if took > 60 || took < 0 || terminal == "" || chain == "" {
		return
	}
	pumpSettleWindow.Lock()
	if pumpSettleWindow.by == nil {
		pumpSettleWindow.by = map[string]map[string][]float64{}
	}
	if pumpSettleWindow.by[terminal] == nil {
		pumpSettleWindow.by[terminal] = map[string][]float64{}
	}
	w := append(pumpSettleWindow.by[terminal][chain], took)
	if len(w) > pumpSettleWindowMax {
		w = w[len(w)-pumpSettleWindowMax:]
	}
	pumpSettleWindow.by[terminal][chain] = w
	per := map[string][]float64{}
	var all []float64
	for c, v := range pumpSettleWindow.by[terminal] {
		per[c] = append([]float64(nil), v...)
		all = append(all, v...)
	}
	pumpSettleWindow.Unlock()

	for c, v := range per {
		if len(v) < pumpSettleMin {
			continue
		}
		gSettleMs.WithLabelValues(terminal, c, "median").Set(quantileOf(v, 0.5) * 1000)
		gSettleMs.WithLabelValues(terminal, c, "p90").Set(quantileOf(v, 0.9) * 1000)
		gSettleMs.WithLabelValues(terminal, c, "mean").Set(meanOf(v) * 1000)
		gSettleMs.WithLabelValues(terminal, c, "over10s_pct").Set(shareOver(v, 10))
	}
	if len(all) >= pumpSettleMin {
		gSettleMs.WithLabelValues(terminal, "all", "median").Set(quantileOf(all, 0.5) * 1000)
		gSettleMs.WithLabelValues(terminal, "all", "p90").Set(quantileOf(all, 0.9) * 1000)
		gSettleMs.WithLabelValues(terminal, "all", "mean").Set(meanOf(all) * 1000)
		gSettleMs.WithLabelValues(terminal, "all", "over10s_pct").Set(shareOver(all, 10))
	}
}

// shareOver: the percentage of settlements slower than `sec` seconds.
//
// Published beside the mean because "stall-free" only removes samples past
// 60 s, and anything from 10 to 60 s still pulls a mean hard: 96 settlements
// at 1 s with 4 at 59 s average 3.3 s against a 1 s median. Without this, two
// routes' means can differ because of a handful of slow ones and nothing on
// the page would say so.
//
// Deliberately NOT a trimmed mean, which was the alternative: discarding the
// slow settlements would hide exactly the behaviour a bridge comparison
// should surface. The tail belongs in the figure; what was missing is a way
// to see how much of the figure is tail.
func shareOver(v []float64, sec float64) float64 {
	if len(v) == 0 {
		return 0
	}
	n := 0
	for _, x := range v {
		if x > sec {
			n++
		}
	}
	return 100 * float64(n) / float64(len(v))
}

// meanOf: the arithmetic mean, which is the only one of the three statistics
// published here that can separate two routes.
//
// Both ends of a settlement are whole-second block timestamps, so every sample
// is 0, 1, 2 or 3 seconds and a median can only ever take one of those values.
// Two routes sharing a median is therefore close to inevitable and carries no
// information: Pump Bridge and the Relay routes both read exactly 1000 ms while
// their per-chain medians and their tails plainly differ. Averaging whole
// seconds recovers the resolution the median discards.
//
// Safe here and NOT safe on the raw histogram, which is the distinction that
// matters: a stall past 60 s never enters this window, while sum/count over
// hPumpSettle includes them and reads 19.8 s against a 0.37 s median.
func meanOf(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	t := 0.0
	for _, x := range v {
		t += x
	}
	return t / float64(len(v))
}

// quantileOf: nearest-rank on a copy, so the value returned is one that was
// actually observed rather than an interpolation between two buckets.
func quantileOf(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	c := append([]float64(nil), v...)
	sort.Float64s(c)
	i := int(p * float64(len(c)))
	if i >= len(c) {
		i = len(c) - 1
	}
	return c[i]
}

// pumpBlockAt returns a block's timestamp, cached per chain.
func pumpBlockAt(ctx context.Context, httpc *http.Client, c originChain, chain string, block int64) int64 {
	pumpBlockTime.Lock()
	if pumpBlockTime.at == nil {
		pumpBlockTime.at = map[string]map[int64]int64{}
	}
	if pumpBlockTime.at[chain] == nil {
		pumpBlockTime.at[chain] = map[int64]int64{}
	}
	if t, ok := pumpBlockTime.at[chain][block]; ok {
		pumpBlockTime.Unlock()
		return t
	}
	// Bounded: a chain producing a block every 0.10 s would otherwise grow
	// this map without limit.
	if len(pumpBlockTime.at[chain]) > 5000 {
		pumpBlockTime.at[chain] = map[int64]int64{}
	}
	pumpBlockTime.Unlock()

	var b struct {
		Timestamp string `json:"timestamp"`
	}
	if err := evmCall(ctx, httpc, c.rpc, "eth_getBlockByNumber",
		[]any{"0x" + big.NewInt(block).Text(16), false}, &b); err != nil {
		return 0
	}
	t := hexInt(b.Timestamp)
	pumpBlockTime.Lock()
	pumpBlockTime.at[chain][block] = t
	pumpBlockTime.Unlock()
	return t
}

// pumpPublishBridgeCost publishes what the schedule costs at the notionals
// bench 003 samples, so Pump Bridge can sit beside the quote-based bridges.
//
// Not a model: the fixed part and the rate are both derived from that chain's
// own spends by the watcher above. Two rates run at once, 40 and 45 bps, so
// the rate used is the flow-weighted mean the gross-up already relies on, and
// the spec's formula says so rather than presenting it as a single schedule.
//
// A notional where the fixed part dominates is exactly where this is worth
// seeing: at $5 the 0.05 alone is 100 bps before any rate applies, which is a
// fact about the product that an average fee figure hides.
func pumpPublishBridgeCost() {
	rate, n := 0.0, 0
	for _, r := range pumpRouters {
		if v := pumpChainRate(r.chain); v > 0 {
			rate += v
			n++
		}
	}
	if n == 0 {
		return
	}
	rate /= float64(n)
	for _, amt := range []float64{5, 50, 300} {
		cost := (pumpFixedUSD + rate*amt) / amt * 100
		gBridgeCostPct.WithLabelValues(strconv.FormatFloat(amt, 'f', -1, 64)).Set(cost)
	}
}

// pumpStableOf: the settlement token a pump row pays in, or "" if unknown.
//
// Needed to tell the user funding a trade from the pool handing the memecoin
// back. Both are ERC20 transfers INTO the router, and treating them alike is
// what silently switched the gross-up off on every row.
func pumpStableOf(slug string) string {
	for _, t := range evmTerminals {
		if t.Slug != slug {
			continue
		}
		for _, known := range pumpRouters {
			// The chain, not the address: Pump Bridge deploys the same
			// router on BNB, Base, Arc, MegaETH and X Layer, so matching
			// the address alone hands every one of them BNB's token.
			if known.chain != t.Chain {
				continue
			}
			for _, router := range t.Routers {
				if strings.EqualFold(router, known.router) {
					return known.token
				}
			}
		}
	}
	return ""
}
