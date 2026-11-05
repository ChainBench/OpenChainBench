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

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

var (
	verdictGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "token_sellability_verdict",
		Help: "1 for the verdict this token currently holds at this tier. " +
			"inconclusive is a verdict of its own: a probe that could not " +
			"tell must say so rather than fall back to a real outcome.",
	}, []string{"chain", "token", "symbol", "tier", "verdict"})

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
	}, []string{"chain", "aggregator", "tier", "provider", "token", "symbol"})

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
		routedTokenGauge)
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
		delay:     envInt("DELAY_BLOCKS", 3),
		sweepGap:  time.Duration(envInt("SWEEP_SECONDS", 900)) * time.Second,
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

	go func() {
		http.Handle("/metrics", promhttp.Handler())
		log.Printf("[sellability] metrics on :%s, aggregator series keyed by %s",
			envOr("PORT", "2112"), strings.Join(askLabels, ", "))
		log.Fatal(http.ListenAndServe(":"+envOr("PORT", "2112"), nil))
	}()

	for {
		sweep(context.Background(), cfg, rpc, quoter)
		time.Sleep(cfg.sweepGap)
	}
}

func sweep(ctx context.Context, cfg config, rpc *rpcClient, q *SushiQuoter) {
	start := time.Now()

	// The control runs FIRST and every sweep, not as an occasional check. A
	// sweep whose control cannot be sold measured the probe rather than the
	// tokens, and publishing its verdicts would accuse somebody on the
	// strength of a broken instrument.
	ctl := probeOne(ctx, cfg, rpc, q, cfg.control)
	ok := 0.0
	if ctl.SameBlock == Sellable {
		ok = 1
	}
	controlGauge.WithLabelValues(cfg.chain, strings.ToLower(cfg.control)).Set(ok)
	if ok == 0 {
		log.Printf("[sellability] control %s did not sell (%s); skipping the sweep",
			cfg.control, ctl.Reason)
		sweepSeconds.WithLabelValues(cfg.chain).Set(time.Since(start).Seconds())
		return
	}

	tokens, err := recentTokens(ctx, rpc, cfg.window)
	if err != nil {
		log.Printf("[sellability] cohort unavailable: %v", err)
		return
	}

	// Forget the previous sweep's cohort before recording this one.
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
	verdictGauge.Reset()
	routedTokenGauge.Reset()
	cohortGauge.WithLabelValues(cfg.chain, "seen").Set(float64(len(tokens)))

	// The tokens that failed, kept per tier. These are the cohort the
	// aggregators are then asked about, and the whole point of the board.
	failed := map[string][]string{"same_block": {}, "delayed": {}}
	// Symbols of the tokens in `failed`, so the ask step can label its
	// evidence without reading symbol() a second time per token.
	symbols := map[string]string{}

	routable, examined := 0, 0
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
		if p.SameBlock == Unsellable {
			failed["same_block"] = append(failed["same_block"], tok)
		}
		if p.Delayed == Unsellable {
			failed["delayed"] = append(failed["delayed"], tok)
		}
		sym := q.Symbol(ctx, rpc, tok)
		symbols[tok] = sym
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
			log.Printf("[sellability] %s (%s) did not sell at either timing", tok, sym)
		}
	}
	cohortGauge.WithLabelValues(cfg.chain, "routable").Set(float64(routable))
	cohortGauge.WithLabelValues(cfg.chain, "examined").Set(float64(examined))
	askAggregators(ctx, cfg, failed, symbols)
	sweepSeconds.WithLabelValues(cfg.chain).Set(time.Since(start).Seconds())
	log.Printf("[sellability] sweep done: %d seen, %d examined, %.1fs",
		len(tokens), examined, time.Since(start).Seconds())
}

func probeOne(ctx context.Context, cfg config, rpc *rpcClient, q *SushiQuoter, token string) Probe {
	buy, err := q.Quote(ctx, cfg.native, token, cfg.ethIn)
	if err != nil || buy.AmountOut == nil || buy.AmountOut.Sign() == 0 {
		return Probe{Token: token, SameBlock: NoRoute, Delayed: NoRoute, Reason: "no buy route"}
	}
	// Sell slightly less than was bought so the sell can never fail on a
	// rounding difference and be read as a refusal.
	amt := new(big.Int).Div(new(big.Int).Mul(buy.AmountOut, big.NewInt(98)), big.NewInt(100))
	sell, err := q.Quote(ctx, token, cfg.native, amt.String())
	if err != nil || sell.To == "" {
		return Probe{Token: token, SameBlock: NoRoute, Delayed: NoRoute, Reason: "no sell route"}
	}
	return Examine(ctx, rpc, cfg.from, token, buy, sell, cfg.delay)
}
