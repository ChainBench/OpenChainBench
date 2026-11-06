// Command monitor samples tokens that are actually moving on Robinhood Chain
// and measures whether each one can be sold, then records which aggregators
// still quote the ones that cannot.
//
// The cohort comes from Transfer logs rather than from a launch event. The
// event that announces a new token on this chain is not identified yet, and
// guessing it would bias the sample towards whichever launchpad was guessed.
// "A token that moved in the last few minutes" is a weaker claim and a true
// one, and it is the population an aggregator would be asked to route into.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// askLabels is the label set of the three aggregator series AND what the
// startup line reports. Sharing the slice is the point: a log line that is
// written independently can describe a binary that is not running, which is
// exactly the question that is hard to answer from outside the container.
var askLabels = []string{"chain", "aggregator", "tier", "provider"}

// scoringRule names the rule a per-token sample was taken under, and it is a
// label so that changing the rule cannot contaminate a window.
//
// A 24h max_over_time does not care that the binary changed. When the 10%
// exit floor was removed, the board kept counting the seven tokens the floor
// had wrongly condemned for another 23 hours, and one of them was the
// chain's own stablecoin. Worse, it still named a leader: without those
// seven, ParaSwap's lead over LI.FI fell from 18.0 points to 1.7, which is
// less than one token.
//
// Bumping this value is how a rule change starts a clean window. Samples
// taken under the old rule carry a different value, or none at all, so a
// query that pins the rule cannot see them. The spec pins it.
//
// reverts-v1: a failed exit is a sale that REVERTS. What the exit is worth
// is recorded in the ledger and never scored.
//
// reverts-v2: same scoring, but the delayed tier sells 30 minutes after the
// buy instead of 48 seconds. That changes which tokens land in the cohort,
// so it cannot share a window with v1. It restarts the same-block window as
// well, which costs nothing here: v1's window was 90 minutes old.
const scoringRule = "reverts-v2"

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

var (
	verdictGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_verdict",
		Help: "1 for the verdict this token currently holds at this tier. " +
			"inconclusive is a verdict of its own: a probe that could not " +
			"tell must say so rather than fall back to a real outcome.",
	}, []string{"chain", "token", "symbol", "tier", "verdict"})

	// How much of the whole examined cohort each aggregator was willing to
	// quote. The board's existing columns divide within the unsellable
	// cohort; these divide over everything, which is the denominator every
	// rate question needs and the one that was missing.
	surveyedGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_surveyed",
		Help: "Examined tokens this aggregator answered about in the last sweep.",
	}, []string{"chain", "aggregator"})

	quotedGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_quoted",
		Help: "Of the examined tokens it answered about, how many this " +
			"aggregator returned a usable route into.",
	}, []string{"chain", "aggregator"})

	surveyedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "token_sellability_surveyed_total",
		Help: "Cumulative examined tokens this aggregator answered about.",
	}, []string{"chain", "aggregator"})

	quotedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "token_sellability_quoted_total",
		Help: "Cumulative examined tokens this aggregator returned a route into.",
	}, []string{"chain", "aggregator"})

	// Published so the filtering is visible rather than silent. A rule that
	// quietly drops rows is indistinguishable from a rule that never fires.
	contradictedGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_contradicted",
		Help: "Tokens whose sale reverted this sweep but which are not yet " +
			"scored against anyone: either the first failure we have seen, " +
			"or a failure after a sale that no later sweep has confirmed. A " +
			"failure that persists becomes scoreable; one that reverses was " +
			"the instrument.",
	}, []string{"chain", "tier"})

	cohortGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_cohort",
		Help: "Tokens in the last sweep by stage: seen in Transfer logs, " +
			"routable by an aggregator, and examined.",
	}, []string{"chain", "stage"})

	sweepSeconds = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_sweep_seconds",
		Help: "Wall-clock seconds the last sweep took.",
	}, []string{"chain"})

	controlGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_control_ok",
		Help: "1 when the control token sold in the same sweep. A sweep " +
			"whose control fails measured the probe, not the tokens, and " +
			"nothing from it should be read.",
	}, []string{"chain", "token"})

	// Asked and routed are separate series, and the board divides one by the
	// other. An aggregator that cannot be reached is absent from both rather
	// than scoring a perfect zero, because a zero here means "never routes
	// into a token you cannot exit", which is the best score on the board
	// and must be earned rather than inherited from an outage.
	askedGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_asked",
		Help: "Tokens classified unsellable at this tier that this " +
			"aggregator was asked to quote in the last sweep.",
	}, askLabels)

	// Asked, per token, so the board can count distinct tokens rather than
	// questions.
	//
	// Three findings share one cause. A counter of questions weights a token
	// that stays in the cohort for twenty sweeps twenty times, so the rate
	// follows persistence rather than prevalence. increase() over a window
	// also has to guess around every restart, and the numerator and
	// denominator do not lose the same amount. And a window that spans a
	// change of sampling, 25 tokens a sweep then 100 then 200 in one day,
	// averages three different experiments: examined per sweep read 200 over
	// the last half hour against 66 over the day.
	//
	// Counting distinct tokens answers all three. Sampling more tokens
	// lowers the variance of the rate without moving it, a token counts once
	// however long it stays, and a restart loses nothing because the series
	// are observations rather than accumulations.
	//
	// Reset with the other per-token series each sweep; Prometheus keeps the
	// history that the window reads.
	askedTokenGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_asked_token",
		Help: "1 when this aggregator answered about this specific token " +
			"from the failed-exit cohort. The denominator of the board, " +
			"counted by token rather than by question.",
	}, []string{"chain", "aggregator", "tier", "provider", "token", "rule"})

	// The evidence behind every percentage on the board: which aggregator
	// offered a route into which named token that our own simulation could
	// not sell back out of.
	//
	// A rate is an accusation in aggregate; this is the list it rests on, so
	// anyone named can check the specific contracts rather than take the
	// share on trust. Reset with the verdicts each sweep, for the same
	// reason: a token quoted yesterday must not be re-exported as though it
	// were quoted now.
	routedTokenGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_routed_token",
		Help: "1 when this aggregator returned a route INTO this specific " +
			"unsellable token in the last sweep. The per-token evidence " +
			"behind the aggregate share.",
	}, []string{"chain", "aggregator", "tier", "provider", "token", "symbol", "rule"})

	// The gauges above say what the LAST sweep established, which is what
	// the absence contract needs: delete them and the row goes quiet. They
	// are the wrong thing to rank on, because a gauge is read at every
	// scrape, so a windowed total counts one sweep as many times as it was
	// scraped and never tells you how much evidence a row rests on.
	//
	// These counters do. increase() over the window is a true count of
	// token-questions, which is both the honest denominator and the
	// sample the page gates on: a row that stopped being asked decays to
	// no evidence and drops out of the ranking instead of inheriting the
	// zero that wins this board.
	askedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "token_sellability_asked_total",
		Help: "Cumulative tokens classified unsellable at this tier that " +
			"this aggregator was asked to quote.",
	}, askLabels)

	routedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "token_sellability_routed_total",
		Help: "Cumulative tokens, of those it was asked about, that this " +
			"aggregator returned a usable route INTO. Lower is better.",
	}, askLabels)

	// Published every sweep even as a zero, unlike asked and routed. It is
	// the only series that separates "this aggregator declined everything",
	// which is the best record on the board, from "this aggregator could
	// not be reached", which is no record at all.
	errorGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_ask_errors",
		Help: "Requests to this aggregator that failed outright in the " +
			"last sweep, so the question could not be put. A non-zero " +
			"value means its asked and routed numbers cover fewer tokens " +
			"than the cohort, and an all-failed sweep publishes neither.",
	}, askLabels)

	routedGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_routed",
		Help: "Of the tokens it was asked about, how many this aggregator " +
			"returned a usable route INTO. Lower is better: these are " +
			"tokens our own simulation could not sell back out of.",
	}, askLabels)
)

func init() {
	prometheus.MustRegister(verdictGauge, cohortGauge, sweepSeconds, controlGauge,
		askedGauge, routedGauge, errorGauge, askedTotal, routedTotal,
		routedTokenGauge, askedTokenGauge, contradictedGauge,
		surveyedGauge, quotedGauge, surveyedTotal, quotedTotal)
}

type config struct {
	chain     string
	rpcURL    string
	control   string
	native    string
	from      string
	ethIn     string
	window    int
	maxTokens int
	delay     int
	sweepGap  time.Duration
	ledgerDir string
	surveyCap int
}

func load() config {
	c := config{
		chain:     envOr("CHAIN", "robinhood"),
		rpcURL:    os.Getenv("RPC_URL"),
		control:   envOr("CONTROL_TOKEN", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
		native:    nativeSentinel,
		from:      envOr("PROBE_FROM", "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416"),
		ethIn:     envOr("ETH_IN_WEI", "20000000000000000"),
		window:    envInt("LOG_WINDOW_BLOCKS", 3000),
		maxTokens: envInt("MAX_TOKENS_PER_SWEEP", 25),
		delay:     envInt("DELAY_BLOCKS", 149),
		sweepGap:  time.Duration(envInt("SWEEP_SECONDS", 900)) * time.Second,
		ledgerDir: envOr("LEDGER_DIR", "/state/aggregate/token-sellability"),
		surveyCap: envInt("SURVEY_CAP", 40),
	}
	return c
}

func envOr(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(k))); err == nil && v > 0 {
		return v
	}
	return d
}

// recentTokens returns the distinct contracts that emitted a Transfer in the
// window, most recent first. These are tokens that exist and move, which is
// all this sample claims.
func recentTokens(ctx context.Context, c *rpcClient, window int) ([]string, error) {
	raw, err := c.call(ctx, "eth_blockNumber", []any{})
	if err != nil {
		return nil, err
	}
	var headHex string
	if err := json.Unmarshal(raw, &headHex); err != nil {
		return nil, err
	}
	head, ok := new(big.Int).SetString(strings.TrimPrefix(headHex, "0x"), 16)
	if !ok {
		return nil, fmt.Errorf("unreadable head %q", headHex)
	}
	from := new(big.Int).Sub(head, big.NewInt(int64(window)))

	raw, err = c.call(ctx, "eth_getLogs", []any{map[string]any{
		"fromBlock": "0x" + from.Text(16),
		"toBlock":   "0x" + head.Text(16),
		"topics":    []string{transferTopic},
	}})
	if err != nil {
		return nil, err
	}
	var logs []struct {
		Address string `json:"address"`
	}
	if err := json.Unmarshal(raw, &logs); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []string{}
	for i := len(logs) - 1; i >= 0; i-- {
		a := strings.ToLower(logs[i].Address)
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	return out, nil
}

func main() {
	cfg := load()
	if cfg.rpcURL == "" {
		log.Fatal("RPC_URL is required")
	}
	rpc := newRPC(cfg.rpcURL)
	quoter := NewSushiQuoter(cfg.from)
	// One window, the same one the board reads over.
	cohort := newCohortMemory(24*time.Hour, cfg.ledgerDir)

	go func() {
		http.Handle("/metrics", promhttp.Handler())
		log.Printf("[sellability] metrics on :%s, aggregator series keyed by %s",
			envOr("PORT", "2112"), strings.Join(askLabels, ", "))
		log.Fatal(http.ListenAndServe(":"+envOr("PORT", "2112"), nil))
	}()

	for {
		sweep(context.Background(), cfg, rpc, quoter, cohort)
		time.Sleep(cfg.sweepGap)
	}
}

func sweep(ctx context.Context, cfg config, rpc *rpcClient, q *SushiQuoter,
	cohort *cohortMemory) {
	start := time.Now()

	// The control runs FIRST and every sweep, not as an occasional check. A
	// sweep whose control cannot be sold measured the probe rather than the
	// tokens, and publishing its verdicts would accuse somebody on the
	// strength of a broken instrument.
	// Both legs, not one. The control used to be read on its same-block
	// verdict alone, so a control that sold in the same block and failed a
	// few blocks later passed the gate, and every delayed verdict in that
	// sweep was published off a probe whose delayed leg was broken. The two
	// timings are two instruments and the gate has to clear both.
	ctl := probeOne(ctx, cfg, rpc, q, cfg.control)
	ok := 0.0
	if ctl.SameBlock == Sellable && ctl.Delayed == Sellable {
		ok = 1
	}
	controlGauge.WithLabelValues(cfg.chain, strings.ToLower(cfg.control)).Set(ok)
	if ok == 0 {
		log.Printf("[sellability] control %s did not sell at both timings "+
			"(same_block=%s %s, delayed=%s %s); skipping the sweep",
			cfg.control, ctl.SameBlock, ctl.SameBlockWhy, ctl.Delayed, ctl.DelayedWhy)
		forgetPreviousCohort()
		sweepSeconds.WithLabelValues(cfg.chain).Set(time.Since(start).Seconds())
		return
	}

	tokens, err := recentTokens(ctx, rpc, cfg.window)
	if err != nil {
		log.Printf("[sellability] cohort unavailable: %v", err)
		forgetPreviousCohort()
		sweepSeconds.WithLabelValues(cfg.chain).Set(time.Since(start).Seconds())
		return
	}

	forgetPreviousCohort()
	cohortGauge.WithLabelValues(cfg.chain, "seen").Set(float64(len(tokens)))

	// The tokens that failed, kept per tier. These are the cohort the
	// aggregators are then asked about, and the whole point of the board.
	failed := map[string][]string{"same_block": {}, "delayed": {}}
	held := map[string]int{"same_block": 0, "delayed": 0}
	// Symbols of the tokens in `failed`, so the ask step can label its
	// evidence without reading symbol() a second time per token.
	symbols := map[string]string{}
	decimals := map[string]int{}

	routable, examined := 0, 0
	var examinedTokens []string
	probes := map[string]Probe{}
	for _, tok := range tokens {
		if examined >= cfg.maxTokens {
			break
		}
		p := probeOne(ctx, cfg, rpc, q, tok)
		if p.SameBlock == NoRoute && p.Delayed == NoRoute {
			continue
		}
		routable++
		examined++
		examinedTokens = append(examinedTokens, tok)
		probes[tok] = p
		// Record what this sweep saw before reading any failure off it, so
		// the decision below is made against the token's whole history.
		//
		// Only a DEFINITE outcome is recorded. Observe used to be handed
		// `v == Sellable`, which made every non-sale advance the run toward
		// a verdict: a node answering with an empty call list, a buy that
		// reverted, a read that timed out. 120 tokens drew Inconclusive in
		// 9h30m. The rule exists to require two real failures and it was
		// accepting two non-answers, which is the opposite of what a
		// confirmation rule is for.
		for tier, v := range map[string]Verdict{"same_block": p.SameBlock, "delayed": p.Delayed} {
			switch v {
			case Sellable:
				cohort.Observe(tok, tier, true)
			case Unsellable:
				cohort.Observe(tok, tier, false)
			}
		}
		for tier, v := range map[string]Verdict{"same_block": p.SameBlock, "delayed": p.Delayed} {
			if v != Unsellable {
				continue
			}
			if !cohort.Scoreable(tok, tier) {
				held[tier]++
				log.Printf("[sellability] %s reverted at %s and is held: %s (%s)",
					tok, tier,
					map[bool]string{true: "awaiting a second failure after a sale",
						false: "first observation"}[cohort.Sold(tok, tier)],
					p.whyAt(tier))
				continue
			}
			failed[tier] = append(failed[tier], tok)
		}
		sym := q.Symbol(ctx, rpc, tok)
		symbols[tok] = sym
		decimals[tok] = q.Decimals(ctx, rpc, tok)
		for tier, v := range map[string]Verdict{"same_block": p.SameBlock, "delayed": p.Delayed} {
			for _, candidate := range []Verdict{Sellable, Unsellable, Inconclusive} {
				val := 0.0
				if v == candidate {
					val = 1
				}
				verdictGauge.WithLabelValues(cfg.chain, tok, sym, tier, string(candidate)).Set(val)
			}
		}
		if p.Confirmed() {
			log.Printf("[sellability] %s (%s) did not sell at either timing: %s",
				tok, sym, p.DelayedWhy)
		}
	}
	for tier, n := range held {
		contradictedGauge.WithLabelValues(cfg.chain, tier).Set(float64(n))
	}
	cohortGauge.WithLabelValues(cfg.chain, "routable").Set(float64(routable))
	cohortGauge.WithLabelValues(cfg.chain, "examined").Set(float64(examined))
	// One campaign, two consumers: the board's columns and the ledger. The
	// survey is the slow part of a sweep by design, because it is paced to
	// what the aggregators tolerate rather than to what we can send.
	// Examining is our RPC and is cheap; asking is their budget and is not.
	asked := surveyCohort(examinedTokens, failed, cfg.surveyCap)
	survey := runSurvey(ctx, cfg, asked, mustCount(failed), decimals)
	scoreFromSurvey(cfg, survey, failed, symbols)
	publishCoverage(cfg, survey, asked)

	entries := make([]ledgerEntry, 0, len(examinedTokens))
	for _, tok := range examinedTokens {
		pr := probes[tok]
		quoted := map[string]string{}
		for _, agg := range Aggregators() {
			q, answered := survey.Quoted(tok, agg.Slug())
			quoted[agg.Slug()] = answer(q, answered)
		}
		entries = append(entries, ledgerEntry{
			At:           time.Now().UTC().Format(time.RFC3339),
			Chain:        cfg.chain,
			Token:        tok,
			Symbol:       symbols[tok],
			SameBlock:    string(pr.SameBlock),
			Delayed:      string(pr.Delayed),
			Why:          pr.DelayedWhy,
			ExitQuoteWei: bigString(pr.ExitQuote),
			Scoreable:    cohort.Scoreable(tok, "delayed"),
			Quoted:       quoted,
		})
	}
	writeLedger(cfg.ledgerDir, cfg.chain, entries)
	sweepSeconds.WithLabelValues(cfg.chain).Set(time.Since(start).Seconds())
	log.Printf("[sellability] sweep done: %d seen, %d examined, %d tracked, %.1fs",
		len(tokens), examined, cohort.Prune(), time.Since(start).Seconds())
}

func probeOne(ctx context.Context, cfg config, rpc *rpcClient, q *SushiQuoter, token string) Probe {
	buy, err := q.Quote(ctx, cfg.native, token, cfg.ethIn)
	if err != nil || buy.AmountOut == nil || buy.AmountOut.Sign() == 0 {
		return Probe{Token: token, SameBlock: NoRoute, Delayed: NoRoute, Reason: "no buy route"}
	}
	// Size the sale from what the buy actually DELIVERED, not from what it
	// was quoted. A token that takes a cut on transfer hands over less than
	// the quote, and selling a fraction of the quote then asks for more than
	// the address holds. That reverts for lack of balance and reads exactly
	// like a refusal to sell, which is how a transfer tax came to look like
	// a trap.
	held, err := rpc.Received(ctx, cfg.from, token, buy)
	if err != nil {
		return Probe{Token: token, SameBlock: Inconclusive, Delayed: Inconclusive,
			Reason: "could not read the balance the buy produced: " + err.Error()}
	}
	if held.Sign() == 0 {
		return Probe{Token: token, SameBlock: NoRoute, Delayed: NoRoute,
			Reason: "the buy delivered nothing"}
	}
	// Still a touch under, so a rounding difference cannot be read as a
	// refusal either.
	amt := new(big.Int).Div(new(big.Int).Mul(held, big.NewInt(99)), big.NewInt(100))
	sell, err := q.Quote(ctx, token, cfg.native, amt.String())
	if err != nil || sell.To == "" {
		return Probe{Token: token, SameBlock: NoRoute, Delayed: NoRoute, Reason: "no sell route"}
	}

	// What the exit is worth is recorded, not scored.
	//
	// There used to be a floor here: an exit returning under a tenth of the
	// stake was called unsellable. It compared the aggregator's QUOTE against
	// the stake and never looked at the proceeds, and it was wrong in both
	// halves. Measured on every token it rejected, with transfer tracing on,
	// each non-reverting exit delivered exactly 100.0% of what its quote
	// promised: USDG 4.084% of stake quoted and 4.084% delivered, Harmonic
	// 2.978 and 2.978, CDOG 0.011 and 0.011, LIQT 0.025 and 0.025. The router
	// enforces a minimum output built from the 5% slippage the quote carries,
	// so a sale that does not revert has already honoured its quote and there
	// is nothing left for a floor to catch.
	//
	// What those four are is thin pools priced honestly. The quote said the
	// round trip loses 96%, and it lost 96%. That is a liquidity fact, and
	// publishing it as a failed exit put the chain's own stablecoin in a
	// cohort of traps.
	//
	// The number is kept so the fact is not lost. A route out that returns a
	// ten-thousandth of the stake deserves a column of its own; it does not
	// deserve this one.
	pr := Examine(ctx, rpc, cfg.from, token, buy, sell, cfg.delay)
	pr.ExitQuote = sell.AmountOut
	return pr
}

// forgetPreviousCohort drops every per-token series from the last sweep.
//
// It runs before this sweep records anything AND on every path that
// abandons a sweep. Leaving it only on the happy path meant a sweep
// that bailed on the control, or on a cohort the node would not serve,
// left the previous sweep's tokens exporting as if they were current.
//
// A GaugeVec keeps every label set it has ever been given and exports
// all of them on every scrape, so without this the process re-publishes
// each token it has ever examined, for as long as it runs. Two things
// break. The scrape payload grows without bound, one series per token
// per tier per verdict. And worse, any count over a window stops meaning
// what it says: "tokens examined in the last 24h" would include a token
// last looked at a week ago, because its gauge is still being emitted
// now. Prometheus keeps the history either way, so a windowed query
// still sees past sweeps; what it must not see is the past dressed as
// the present.
func forgetPreviousCohort() {
	verdictGauge.Reset()
	routedTokenGauge.Reset()
	askedTokenGauge.Reset()
}

// bigString renders a big.Int for the ledger, and an absent one as the empty
// string so the field is omitted rather than written as a zero that would
// read as "the exit was worth nothing".
func bigString(v *big.Int) string {
	if v == nil {
		return ""
	}
	return v.String()
}

// mustCount is how many distinct tokens the score needs an answer about this
// sweep. It is the floor under every aggregator's budget: a cap that cut
// into these would shrink the denominator it is there to protect.
func mustCount(failed map[string][]string) int {
	seen := map[string]bool{}
	for _, toks := range failed {
		for _, t := range toks {
			seen[t] = true
		}
	}
	return len(seen)
}
