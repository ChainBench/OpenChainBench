// terminal-fill-quality: what a swap costs the user on each Solana trading
// terminal / Telegram bot, measured on-chain.
//
// Feeds bench 268 (terminal-fill-quality), the /trading-apps hub and the
// "Trading app" view on /products/<slug>.
//
// Method. Every terminal takes its fee through known wallets (the lists
// DeFiLlama's adapters and Dune's spellbook match on). A WebSocket feed
// of every transaction mentioning those wallets yields every swap the
// terminal routed, failed ones included; a random sample of the
// successful ones is read with getTransaction. A Solana transaction
// carries the pre/post SOL and token balances of every account it
// touches, so for each sampled swap we know exactly what the user paid,
// what the pool received, what the terminal, the network (tx fee +
// inclusion tips) and everyone else took, and what the user got. The
// received tokens are valued at the pool's own state before the swap
// (its reserves, or the previous trade on it), so the figure is what a
// TCA desk would compute: implementation shortfall, not marketing
// slippage. See parse.go.
//
// Failed swap attempts are counted from the feed's logs: the user paid
// the priority fee for nothing, which no fill metric shows otherwise.
//
// Rolling window (WINDOW_HOURS) of samples; state persisted to disk so a
// restart keeps the window.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	gLoss = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_loss_bps", Help: "Value lost per swap vs the pool's pre-trade state, basis points of the trade (priced samples, rolling window); stat=median|p90|ci_lo|ci_hi",
	}, []string{"terminal", "chain", "stat"})
	gComponent = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_component_bps", Help: "Median cost component per swap, basis points of the trade",
	}, []string{"terminal", "chain", "component"})
	gFail = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_fail_rate_pct", Help: "Share of the terminal's swap attempts that failed on-chain, percent (rolling window, every attempt the feed saw)",
	}, []string{"terminal", "chain"})
	gSamples = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_sample_size", Help: "Samples in the window: seen (swap attempts), parsed (swaps), priced (with a loss figure)",
	}, []string{"terminal", "chain", "kind"})
	gTrade = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_trade_usd", Help: "Sampled trade size in USD",
	}, []string{"terminal", "chain", "stat"})
	gVenue = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_venue_share_pct", Help: "Share of sampled swaps per venue",
	}, []string{"terminal", "chain", "venue"})
	gBuy = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_buy_share_pct", Help: "Share of sampled swaps that are buys",
	}, []string{"terminal", "chain"})
	gSandwich = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_sandwich_pct", Help: "Share of screened swaps with a front-run and a back-run by the same signer on the same pool (informative; coverage depends on pool activity)",
	}, []string{"terminal", "chain"})
	gSandwichProfit = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_sandwich_profit_bps", Help: "Median attacker profit on sandwiched swaps, basis points of the victim's trade",
	}, []string{"terminal", "chain"})
	gLossSize = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_loss_bps_size", Help: "Median loss per swap by trade-size bucket (under25, 25to250, over250 USD)",
	}, []string{"terminal", "chain", "bucket"})
	gLossChain = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_loss_bps_chain", Help: "Cross-chain apps: median loss per swap by origin chain (bnb, robinhood, base, ethereum, arc)",
	}, []string{"terminal", "chain", "origin"})
	gHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_health", Help: "1 when the terminal has at least MIN_PRICED priced samples in the window",
	}, []string{"terminal", "chain"})
	gRanked = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_ranked", Help: "1 when the terminal has at least MIN_RANK priced samples (its median is stable enough to rank)",
	}, []string{"terminal", "chain"})
	gFailCost = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_fail_cost_usd", Help: "Median transaction fee paid on a failed swap attempt, USD (sampled failed attempts, rolling window)",
	}, []string{"terminal", "chain"})
	gFailOverhead = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_fail_overhead_bps", Help: "Expected fee burnt on failed attempts per successful swap: fail rate / (1 − fail rate) × median failed-attempt fee, basis points of the median trade",
	}, []string{"terminal", "chain"})
	gRefresh = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_last_refresh_unix", Help: "Last successful tick"})
	gFeed    = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_feed_up", Help: "1 when the WebSocket feed is connected and heard something in the last two minutes"})
	gSol     = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_sol_usd", Help: "SOL/USD used for sizing"})
	cCalls   = prometheus.NewCounter(prometheus.CounterOpts{Name: "tfq_rpc_calls_total", Help: "RPC calls"})
	cErrors  = prometheus.NewCounter(prometheus.CounterOpts{Name: "tfq_rpc_errors_total", Help: "RPC errors and rate limits"})
)

func init() {
	prometheus.MustRegister(gLoss, gComponent, gFail, gSamples, gTrade, gVenue, gBuy, gSandwich, gSandwichProfit, gLossSize, gLossChain, gHealth, gRanked, gFailCost, gFailOverhead, gRefresh, gFeed, gSol, cCalls, cErrors)
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// minuteBucket: the feed's counts for one terminal over one minute (swap
// attempts seen and failed, by error class; notifications that were not
// attempts), kept for the fail rate.
type minuteBucket struct {
	T      int64          `json:"t"`
	Seen   int            `json:"seen"`
	Failed int            `json:"failed"`
	Other  int            `json:"other"`
	Errs   map[string]int `json:"errs,omitempty"`
	// Native EVM terminals: attempts found in the sampled blocks
	// (transactions sent to the routers) and the reverted ones among them.
	SampSeen   int `json:"ss,omitempty"`
	SampFailed int `json:"sf,omitempty"`
}

// recordSample adds a block sample's attempts and reverts (native EVM).
func (st *State) recordSample(slug string, now int64, seen, failed int) {
	if seen == 0 {
		return
	}
	m := now - now%60
	b := st.Buckets[slug]
	if len(b) == 0 || b[len(b)-1].T != m {
		b = append(b, minuteBucket{T: m})
	}
	b[len(b)-1].SampSeen += seen
	b[len(b)-1].SampFailed += failed
	st.Buckets[slug] = b
}

type walletCursor struct {
	Last     string `json:"last"` // newest signature already scanned
	Idle     int    `json:"idle"` // consecutive empty scans, for backoff
	NextScan int64  `json:"next"`
}

// failSample: one failed swap attempt read from the chain, for the cost
// of failures. A failed transaction executes nothing but still pays its
// fee (base + priority); tips inside it are not transferred.
type failSample struct {
	Terminal  string  `json:"terminal"`
	Sig       string  `json:"sig"`
	Time      int64   `json:"time"`
	FeeSOL    float64 `json:"fee_sol"`
	FeeUSD    float64 `json:"fee_usd"`
	Sponsored bool    `json:"sponsored,omitempty"` // the terminal's own signer paid (FOMO)
	Err       string  `json:"err,omitempty"`
}

type State struct {
	Swaps     []Swap                    `json:"swaps"`
	Fails     []failSample              `json:"fails"`
	Buckets   map[string][]minuteBucket `json:"buckets"`              // terminal -> per-minute feed counts
	Rejects   map[string]map[string]int `json:"rejects"`              // terminal -> reason -> count (window not enforced; informative)
	Cursors   map[string]*walletCursor  `json:"cursors"`              // wallet -> cursor (polling fallback)
	EvmCursor map[string]int64          `json:"evm_cursor,omitempty"` // chain -> last block scanned for the native EVM terminals
	Learned   map[string]*Learned       `json:"learned,omitempty"`    // terminal -> fee wallets / routers learned from the chain (discover.go)
}

// record adds a tick's feed counts to the terminal's current minute.
func (st *State) record(slug string, now int64, seen, failed, other int, errs map[string]int) {
	if seen == 0 && other == 0 {
		return
	}
	m := now - now%60
	b := st.Buckets[slug]
	if len(b) == 0 || b[len(b)-1].T != m {
		b = append(b, minuteBucket{T: m})
	}
	last := &b[len(b)-1]
	last.Seen += seen
	last.Failed += failed
	last.Other += other
	if len(errs) > 0 {
		if last.Errs == nil {
			last.Errs = map[string]int{}
		}
		for k, v := range errs {
			last.Errs[k] += v
		}
	}
	st.Buckets[slug] = b
}

type TerminalStats struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	Note string `json:"note,omitempty"`
	/** The product (fomo, gmgn, …) and the chain of this entry: one chain per row, "all" for the product's pooled entry over every chain it trades on (the headline). "funding" is a cross-chain app's bridge leg, left out of the pool. */
	Product string `json:"product"`
	Chain   string `json:"chain"`
	/** Feed counts over the window: swap attempts, failed ones, top error classes, non-swap notifications. */
	Seen        int            `json:"seen"`
	Failed      int            `json:"failed"`
	FailRate    *float64       `json:"fail_rate_pct,omitempty"`
	FailReasons map[string]int `json:"fail_reasons,omitempty"`
	NonSwap     int            `json:"non_swap"`
	/** Native EVM terminals: the fail rate comes from a block sample (transactions sent to the routers, reverted or not), these are its counts. */
	SampSeen   int `json:"sampled_attempts,omitempty"`
	SampFailed int `json:"sampled_failed,omitempty"`
	/** The base of the fail rate: the feed's attempts (Solana), the block sample's (native EVM), both on a pooled product. */
	Attempts       int `json:"attempts"`
	AttemptsFailed int `json:"attempts_failed"`
	/** Cost of failures: sampled failed attempts, the median fee they paid, and the expected burn per successful swap in bps of the median trade. */
	FailsSampled    int        `json:"fails_sampled"`
	FailCostUSD     *Quantiles `json:"fail_cost_usd,omitempty"`
	FailOverheadBps *float64   `json:"fail_overhead_bps,omitempty"`
	Parsed          int        `json:"parsed"`
	Priced          int        `json:"priced"`
	Flagged         int        `json:"flagged"` // priced but out of bounds, excluded
	/** Loss vs the pool's pre-trade state: median with its 95 % bootstrap interval, p90. */
	Loss        *Quantiles         `json:"loss_bps,omitempty"`
	Components  map[string]float64 `json:"components_bps"` // medians
	TradeUSD    *Quantiles         `json:"trade_usd,omitempty"`
	BuySharePct float64            `json:"buy_share_pct"`
	Venues      map[string]float64 `json:"venue_share_pct"`
	Quotes      map[string]float64 `json:"quote_share_pct"`
	Rejects     map[string]int     `json:"rejects,omitempty"`
	/** Share of priced samples by reference source: reserves (exact mid), pool (previous trade). */
	RefPoolPct float64            `json:"ref_pool_pct"`
	RefSrcPct  map[string]float64 `json:"ref_src_pct"`
	/** Sandwich screen: swaps whose neighbourhood was read, how many were sandwiched, attacker profit. Informative. */
	Scanned        int        `json:"scanned"`
	Sandwiched     int        `json:"sandwiched"`
	SandwichPct    *float64   `json:"sandwich_pct,omitempty"`
	SandwichProfit *Quantiles `json:"sandwich_profit_bps,omitempty"`
	/** Loss by trade-size bucket. */
	BySize map[string]*Quantiles `json:"by_size,omitempty"`
	/** Cross-chain apps: loss by origin chain (bnb, robinhood, base, ethereum, arc), with the median's interval. */
	ByChain map[string]*Quantiles `json:"by_chain,omitempty"`
	/** Largest "other" recipients over the window, for audit: pubkey, label when known, count, quote received in USD. */
	OtherTop []OtherRecipient `json:"other_top,omitempty"`
	/** Healthy: at least MIN_PRICED priced swaps (figure published). Ranked: at least MIN_RANK (figure ranked). */
	Healthy bool `json:"healthy"`
	Ranked  bool `json:"ranked"`
}

type OtherRecipient struct {
	Pubkey string  `json:"pubkey"`
	Label  string  `json:"label,omitempty"`
	Count  int     `json:"count"`
	Quote  float64 `json:"quote_sum"`
}

type Quantiles struct {
	Median float64  `json:"median"`
	P90    float64  `json:"p90"`
	N      int      `json:"n"`
	CILo   *float64 `json:"ci_lo,omitempty"` // 95 % bootstrap interval of the median
	CIHi   *float64 `json:"ci_hi,omitempty"`
}

type Public struct {
	GeneratedAt   string          `json:"generated_at"`
	WindowHours   int             `json:"window_hours"`
	MethodVersion int             `json:"method_version"`
	MinPriced     int             `json:"min_priced"`
	MinRank       int             `json:"min_rank"`
	SolUSD        float64         `json:"sol_usd"`
	Method        string          `json:"method"`
	Terminals     []TerminalStats `json:"terminals"`
	Recent        []Swap          `json:"recent"`
	/** Cohort discovery: fee wallets and routers learned from the chain, evidence per platform, unattributed fee-like recipients. */
	Discovery *Discovery `json:"discovery,omitempty"`
}

func main() {
	rpcURL := os.Getenv("SOLANA_RPC")
	if rpcURL == "" {
		if k := os.Getenv("HELIUS_API_KEY"); k != "" {
			rpcURL = "https://mainnet.helius-rpc.com/?api-key=" + k
		} else {
			rpcURL = "https://api.mainnet-beta.solana.com"
		}
	}
	tick := time.Duration(envInt("TICK_SECONDS", 60)) * time.Second
	dailyTarget := envInt("DAILY_TARGET", 300) // swaps read per terminal per day
	perTick := float64(dailyTarget) * tick.Seconds() / 86400
	perTickFail := float64(envInt("FAIL_DAILY_TARGET", 40)) * tick.Seconds() / 86400 // failed attempts read per terminal per day
	windowHours := envInt("WINDOW_HOURS", 24)
	minPriced := envInt("MIN_PRICED", 50)
	minRank := envInt("MIN_RANK", 100)
	useWS := envInt("WS", 1) == 1
	minTradeUSD = float64(envInt("MIN_TRADE_USD", 2))
	stateFile := os.Getenv("STATE_FILE")
	publicFile := os.Getenv("HISTORY_FILE_PUBLIC")
	addr := os.Getenv("METRICS_ADDR")
	if addr == "" {
		addr = ":2112"
	}
	log.Printf("OpenChainBench #268: terminal fill quality, method v%d, %d Solana terminals | tick=%s target=%d swaps/terminal/day window=%dh publish>=%d rank>=%d ws=%v", methodVersion, len(terminals), tick, dailyTarget, windowHours, minPriced, minRank, useWS)

	// Redirects are not followed: a public RPC that answers a heavy query
	// with a redirect to a private address (seen on Robinhood Chain's
	// eth_getLogs) would otherwise hang every call for the whole timeout.
	httpc := &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	rps := envInt("RPC_RPS", 8)
	rpc := &rpcClient{url: rpcURL, http: httpc, calls: cCalls.Inc, errors: cErrors.Inc, minGap: time.Second / time.Duration(max(rps, 1))}

	applyRPCOverrides()
	st := loadState(stateFile)
	applyLearned(st)
	pools := &poolCache{m: map[string]poolParams{}}
	quota := map[string]float64{}
	failQuota := map[string]float64{}
	activity := map[string]float64{} // running successful attempts per tick, per terminal
	var fd *feed
	if useWS {
		// WS_URL lets the feed run on another endpoint than the reads (the
		// public wss://api.mainnet-beta.solana.com is free and keyless).
		wsURL := os.Getenv("WS_URL")
		if wsURL == "" {
			wsURL = rpcURL
		}
		fd = newFeed(wsURL)
		go fd.run(context.Background())
	}
	if st.EvmCursor == nil {
		st.EvmCursor = map[string]int64{}
	}
	nf := newNativeFeed(httpc, st.EvmCursor)
	xf := newXfeed(httpc)
	go xf.run(context.Background(), tick)
	var mu sync.RWMutex
	var pub *Public

	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/v1/fills", func(w http.ResponseWriter, r *http.Request) {
		mu.RLock()
		defer mu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		if pub == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"error":"not ready"}`))
			return
		}
		json.NewEncoder(w).Encode(pub)
	})
	go func() { log.Fatal(http.ListenAndServe(addr, nil)) }()

	sol := 0.0
	// Cohort discovery every DISCOVER_EVERY ticks (6 h at a 1-minute
	// tick), first at the third tick; the last result stays in the JSON.
	discoverEvery := envInt("DISCOVER_EVERY", 360)
	var disc *Discovery
	tickN := 0
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		tickN++
		if p, err := solPrice(ctx, httpc); err == nil && p > 0 {
			sol = p
			gSol.Set(p)
		} else if sol == 0 {
			log.Printf("[price] %v (no SOL price yet, sizing skipped this tick)", err)
		}
		start := time.Now()
		if sol == 0 {
			cancel()
			log.Printf("[price] no SOL price, retrying in 30s")
			time.Sleep(30 * time.Second)
			continue
		}
		added, seen := sample(ctx, rpc, st, sol, pools, fd, quota, failQuota, activity, perTick, perTickFail)
		gas := gasPrices(ctx, httpc)
		added += sampleXchain(ctx, rpc, httpc, st, sol, gas, xf, pools, quota, perTick)
		a2, s2 := sampleNative(ctx, httpc, st, nf, gas, quota, perTick)
		added += a2
		seen += s2
		if tickN == 3 || (discoverEvery > 0 && tickN%discoverEvery == 0) {
			d, resub := discover(ctx, rpc, httpc, st, sol, time.Now().Unix())
			disc = d
			if resub && fd != nil {
				fd.resubscribe()
			}
			log.Printf("[discover] %s: %d platforms with evidence, %d unattributed fee-like recipients, adopted %v", d.Source, len(d.Platforms), len(d.Unattributed), d.Adopted)
		}
		cancel()
		prune(st, windowHours)
		stats := compute(st, minPriced, minRank)
		publishGauges(stats)
		gRefresh.Set(float64(time.Now().Unix()))
		live := fd != nil && fd.healthy()
		if live {
			gFeed.Set(1)
		} else {
			gFeed.Set(0)
		}
		p := &Public{
			GeneratedAt: time.Now().UTC().Format(time.RFC3339), WindowHours: windowHours, MethodVersion: methodVersion, MinPriced: minPriced, MinRank: minRank, SolUSD: sol,
			Method:    "Random sample of the swaps each terminal routed (fee-wallet feed), read on-chain; loss = 1 − value received at the pool's pre-trade state / value given, basis points of the trade; the split (terminal, network, other, pool) is exact from balance deltas.",
			Terminals: stats, Recent: recent(st, 400), Discovery: disc,
		}
		mu.Lock()
		pub = p
		mu.Unlock()
		if stateFile != "" {
			if err := writeAtomic(stateFile, st); err != nil {
				log.Printf("[state] %v", err)
			}
		}
		if publicFile != "" {
			if err := writeAtomic(publicFile, p); err != nil {
				log.Printf("[public] %v", err)
			}
		}
		log.Printf("[tick] %s: %d swap attempts seen (%s), %d swaps added, %d in window, %s", start.UTC().Format(time.RFC3339), seen, map[bool]string{true: "ws", false: "poll"}[live], added, len(st.Swaps), time.Since(start).Round(100*time.Millisecond))
		time.Sleep(time.Until(start.Add(tick)))
	}
}

// sample drains the live feed (or, when the feed is down, polls the fee
// wallets), records every swap attempt for the fail rate, draws the
// tick's quota of successful ones at random and reads them.
//
// Quota: DAILY_TARGET swaps per terminal per day, spread over the ticks
// (fractional carry, capped at three ticks' worth), so the sample size
// follows the precision wanted for a median rather than the tick length.
// The tick's draw is scaled by the tick's activity against the terminal's
// running average, so the sample is uniform over transactions, not over
// minutes: a burst (a pump, where fills are worst) is represented in
// proportion to its trades. Nothing accrues on a tick without activity.
func sample(ctx context.Context, rpc *rpcClient, st *State, solUSD float64, pools *poolCache, fd *feed, quota, failQuota, activity map[string]float64, perTick, perTickFail float64) (added, seen int) {
	now := time.Now().Unix()
	live := fd != nil && fd.healthy()
	for _, t := range terminals {
		var ok []sigInfo
		okCount := 0.0
		if live {
			d := fd.drain(t.Slug)
			seen += d.seen
			st.record(t.Slug, now, d.seen, d.failed, d.other, d.errs)
			ok = d.sample
			okCount = float64(d.total)
			sampleFails(ctx, rpc, st, t, d.failedSample, failQuota, perTickFail, solUSD, now)
		} else {
			// Polling fallback: newest page per wallet since the last cursor.
			// Without logs every signature counts as an attempt (approximate).
			var fresh []sigInfo
			for _, w := range t.scanAddresses() {
				cur := st.Cursors[w]
				if cur == nil {
					cur = &walletCursor{}
					st.Cursors[w] = cur
				}
				if cur.NextScan > now {
					continue
				}
				sigs, err := rpc.signatures(ctx, w, 100, cur.Last)
				if err != nil {
					log.Printf("[%s] %s: %v", t.Slug, w[:6], err)
					continue
				}
				if len(sigs) == 0 {
					cur.Idle++
					cur.NextScan = now + int64(math.Min(3600, 180*math.Pow(2, float64(cur.Idle))))
					continue
				}
				cur.Idle = 0
				cur.NextScan = 0
				if cur.Last == "" {
					sigs = sigs[:min(len(sigs), 40)]
				}
				cur.Last = sigs[0].Signature
				fresh = append(fresh, sigs...)
			}
			seen += len(fresh)
			failed := 0
			for _, s := range fresh {
				if s.failed() {
					failed++
				} else {
					ok = append(ok, s)
				}
			}
			st.record(t.Slug, now, len(fresh), failed, 0, nil)
			okCount = float64(len(ok))
		}
		if okCount == 0 {
			continue
		}
		w := 1.0
		if a := activity[t.Slug]; a > 0 {
			w = okCount / a
		}
		if activity[t.Slug] == 0 {
			activity[t.Slug] = okCount
		} else {
			activity[t.Slug] = 0.9*activity[t.Slug] + 0.1*okCount
		}
		quota[t.Slug] += perTick * w
		if cap := math.Max(3*perTick, 2); quota[t.Slug] > cap {
			quota[t.Slug] = cap
		}
		n := int(quota[t.Slug])
		if n > len(ok) {
			n = len(ok)
		}
		if n <= 0 {
			continue
		}
		quota[t.Slug] -= float64(n)
		rand.Shuffle(len(ok), func(i, j int) { ok[i], ok[j] = ok[j], ok[i] })
		for _, s := range ok[:n] {
			tx, err := rpc.transaction(ctx, s.Signature)
			if err != nil || tx == nil {
				if err != nil {
					log.Printf("[%s] tx %s: %v", t.Slug, s.Signature[:8], err)
				}
				continue
			}
			sw, reject := parseSwap(t, s.Signature, tx, solUSD, "")
			if reject != "" {
				st.reject(t.Slug, reject)
				continue
			}
			if sw.Time == 0 {
				sw.Time = now
			}
			priceSwap(ctx, rpc, sw, tx, pools, solUSD, now)
			st.Swaps = append(st.Swaps, *sw)
			added++
		}
	}
	return added, seen
}

func (st *State) reject(slug string, r parseReject) {
	if st.Rejects[slug] == nil {
		st.Rejects[slug] = map[string]int{}
	}
	st.Rejects[slug][string(r)]++
}

// priceSwap sets the swap's reference price and runs the sandwich screen:
// the exact pre-trade mid from the pool's reserves when the route is one
// constant-product pool, else from the venue's own swap event (Launchpad,
// Meteora DLMM), else the previous trade on the pool (at most 60 s
// earlier); the pool neighbourhood is read anyway for the screen.
func priceSwap(ctx context.Context, rpc *rpcClient, sw *Swap, tx *parsedTx, pools *poolCache, solUSD float64, now int64) {
	if sw.PoolBasePre > 0 && sw.PoolQuotePre > 0 {
		if p, ok := reservePrice(ctx, rpc, sw, pools, solUSD); ok {
			sw.finalize(&p, 0, "reserves")
		}
	}
	if sw.RefSrc == "" {
		if p, ok := eventMid(ctx, rpc, sw, tx, solUSD); ok {
			sw.finalize(&p, 0, "reserves")
		}
	}
	if sw.PoolVault == "" {
		return
	}
	nb, err := poolNeighbours(ctx, rpc, sw)
	if err != nil {
		return
	}
	var prevTx *parsedTx
	for i, ps := range nb.prev {
		ptx, err := rpc.transaction(ctx, ps.Signature)
		if err != nil || ptx == nil {
			continue
		}
		if i == 0 {
			prevTx = ptx
		}
		if sw.RefSrc != "" {
			break // reference known; only the immediate neighbour is needed for the screen
		}
		if p := poolTradePrice(ptx, sw, solUSD); p > 0 {
			age := int64(0)
			if ps.BlockTime != nil {
				age = sw.Time - *ps.BlockTime
			}
			if age <= refMaxAgeS {
				sw.finalize(&p, age, "pool")
			}
			break
		}
	}
	if sd, ok := screenSandwich(ctx, rpc, sw, nb, prevTx, solUSD, now); ok {
		sw.Scanned = true
		sw.Sandwich = sd
		sw.BlockPoolTxs = len(nb.prev)
	}
}

// sampleXchain drains the Relay feed: counts every final request of each
// cross-chain app for its fail rate, draws the tick's quota of successful
// token settlements on Solana and measures them (see xchain.go).
func sampleXchain(ctx context.Context, rpc *rpcClient, httpc *http.Client, st *State, solUSD float64, gas map[string]float64, xf *xfeed, pools *poolCache, quota map[string]float64, perTick float64) (added int) {
	if xf == nil || !xf.healthy() {
		return 0
	}
	now := time.Now().Unix()
	for _, slug := range xchainRows() {
		seen, failed, errs, sample, total := xf.drain(slug)
		st.record(slug, now, seen, failed, 0, errs)
		if total == 0 {
			continue
		}
		quota[slug] += perTick
		if cap := math.Max(3*perTick, 2); quota[slug] > cap {
			quota[slug] = cap
		}
		n := int(quota[slug])
		if n > len(sample) {
			n = len(sample)
		}
		if n <= 0 {
			continue
		}
		quota[slug] -= float64(n)
		rand.Shuffle(len(sample), func(i, j int) { sample[i], sample[j] = sample[j], sample[i] })
		t := Terminal{Slug: slug, Kind: "app"}
		for _, x := range sample[:n] {
			if x.DestChain != "" || (x.InIsToken && x.Chain != "solana") {
				// Leaving Solana for a token elsewhere (the deposit is read on
				// Solana, the delivery and the pool's state on the destination),
				// or a token sold on the origin chain and settled on Solana.
				var sw *Swap
				if x.DestChain != "" {
					sw = evmRow(ctx, rpc, httpc, t, x, solUSD, gas)
				} else {
					sw = evmSaleRow(ctx, rpc, httpc, t, x, solUSD, gas)
				}
				if sw != nil {
					if sw.Flag != "" && sw.Flag != "origin_token" {
						if sw.Flag == "out_of_bounds" || sw.Flag == "split_implausible" {
							loss := 0.0
							if sw.LossBps != nil {
								loss = *sw.LossBps
							}
							log.Printf("[evm] %s %s %s %s: loss %.0f bps, given %.2f, pool %.2f, relay %.2f, tokens %.6g, ref %.4g", slug, sw.Side, x.InTx+"/"+x.OutTx, sw.Flag, loss, sw.UserQ*sw.QuoteUSD, sw.PoolQ*sw.QuoteUSD, sw.RelayQ*sw.QuoteUSD, sw.Tokens, refOf(sw))
						}
						st.reject(slug, parseReject(sw.Flag))
						continue
					}
					if sw.TradeUSD < minTradeUSD {
						st.reject(slug, rejectDust)
						continue
					}
					st.Swaps = append(st.Swaps, *sw)
					added++
				} else {
					st.reject(slug, "unreadable")
				}
				continue
			}
			if x.UsdIn <= 0 {
				st.reject(slug, "no_usd_in")
				continue
			}
			tx, err := rpc.transaction(ctx, x.OutTx)
			if err != nil || tx == nil {
				continue
			}
			gasUSD, gasOK := originGasUSD(ctx, httpc, x.Chain, x.InTx, gas)
			// The deposit read on the origin chain itself (native value or a
			// priced ERC20) replaces Relay's valuation; a token deposit keeps
			// Relay's figure and the origin_token flag.
			if oc := chainByID(0); oc == nil {
				for i := range originChains {
					if originChains[i].slug == x.Chain {
						if given, ok := originGivenUSD(ctx, httpc, originChains[i], x.InTx, x.User, gas); ok && given > 0 {
							x.UsdIn, x.InIsToken = given, false
						}
					}
				}
			}
			var sw *Swap
			if x.OutIsToken {
				// The settlement bought the token on Solana: value received =
				// the tokens at the pool's state before the settlement swap.
				var reject parseReject
				sw, reject = parseSwap(t, x.OutTx, tx, solUSD, x.Recipient)
				if reject != "" {
					st.reject(slug, reject)
					continue
				}
				if sw.Side != "buy" || sw.QuoteUSD <= 0 {
					st.reject(slug, "not_buy")
					continue
				}
				q := sw.QuoteUSD
				sw.UserQ = (x.UsdIn + gasUSD) / q // what the user sent on the origin chain, plus its gas
				sw.TerminalQ = x.AppFeeUsd / q
				sw.RelayQ = x.RelayFeeUsd / q
				sw.NetworkQ = gasUSD / q
				sw.Others, sw.OtherQ = nil, nil
				if sw.PoolQ > 0 && sw.Pools == 1 {
					o := sw.UserQ - sw.PoolQ - sw.TerminalQ - sw.RelayQ - sw.NetworkQ
					if o < 0 {
						o = 0
					}
					sw.OtherQ = &o
				}
			} else {
				// The settlement delivered SOL or a stable to the user (FOMO
				// funds the Solana wallet this way, the token buy is then a
				// native swap): value received is exact, the bridge's take is
				// what is left of the deposit after the app fee and the gas.
				sw = bridgeRow(t, x, tx, solUSD, gasUSD)
				if sw == nil {
					st.reject(slug, "no_quote_received")
					continue
				}
			}
			if sw.Time == 0 {
				sw.Time = now
			}
			sw.Chain, sw.RelayID, sw.InTx = x.Chain, x.ID, x.InTx
			if !gasOK {
				sw.Flag = "gas_unknown"
			}
			flag := sw.Flag
			if x.OutIsToken {
				sw.finalize(nil, 0, "")
				if sw.TradeUSD < minTradeUSD {
					st.reject(slug, rejectDust)
					continue
				}
				priceSwap(ctx, rpc, sw, tx, pools, solUSD, now)
			} else {
				one := 1.0
				sw.finalize(&one, 0, "reserves") // quote per quote: exact by construction
				if sw.TradeUSD < minTradeUSD {
					st.reject(slug, rejectDust)
					continue
				}
			}
			if sw.Flag == "" {
				sw.Flag = flag
			}
			if x.InIsToken {
				// The user paid with a token on the origin chain: what it was
				// worth is Relay's own valuation, not an on-chain mid, and the
				// figure carries that token's sale. Kept, shown, not counted.
				sw.Flag = "origin_token"
				sw.Priced = false
			}
			st.Swaps = append(st.Swaps, *sw)
			added++
		}
	}
	return added
}

// refMaxAgeS: a previous trade older than this is no arrival price (the
// pool may have moved for other reasons); the swap stays unpriced.
const refMaxAgeS = 60

// sampleFails reads a few of the tick's failed attempts (quota
// FAIL_DAILY_TARGET per terminal per day) for the fee they paid.
func sampleFails(ctx context.Context, rpc *rpcClient, st *State, t Terminal, failed []sigInfo, failQuota map[string]float64, perTickFail, solUSD float64, now int64) {
	if len(failed) == 0 {
		return
	}
	failQuota[t.Slug] += perTickFail
	if cap := math.Max(3*perTickFail, 1); failQuota[t.Slug] > cap {
		failQuota[t.Slug] = cap
	}
	n := int(failQuota[t.Slug])
	if n > len(failed) {
		n = len(failed)
	}
	if n <= 0 {
		return
	}
	failQuota[t.Slug] -= float64(n)
	internal := set(t.Internal...)
	rand.Shuffle(len(failed), func(i, j int) { failed[i], failed[j] = failed[j], failed[i] })
	for _, s := range failed[:n] {
		tx, err := rpc.transaction(ctx, s.Signature)
		if err != nil || tx == nil {
			continue
		}
		f := failSample{Terminal: t.Slug, Sig: s.Signature, Time: now, Err: errClass(tx.Meta.Err)}
		if tx.BlockTime != nil {
			f.Time = *tx.BlockTime
		}
		if payer := tx.Transaction.Message.AccountKeys[0].Pubkey; internal[payer] {
			f.Sponsored = true
		} else {
			f.FeeSOL = float64(tx.Meta.Fee) / 1e9
			f.FeeUSD = f.FeeSOL * solUSD
		}
		st.Fails = append(st.Fails, f)
	}
}

// poolParams are the constants a pool needs for its exact mid: the
// virtual quote offset (PumpSwap migrated pools) and, for the pump.fun
// curve, the virtual token offset plus the non-reserve lamports of the
// curve account. Stored in raw units (SOL, tokens) and converted to the
// swap's quote unit at use time: the cache is shared by swaps quoted in
// SOL and in stables on the same pool. Bounded: cleared past 20k pools.
type poolParams struct {
	quoteOffsetSOL float64 // SOL
	tokenOffset    float64 // tokens
	nonReserveSOL  float64 // SOL held on the curve account that is not real_sol (rent)
	ok             bool
}

type poolCache struct {
	mu sync.Mutex
	m  map[string]poolParams
}

const poolCacheMax = 20000

// reservePrice computes the pool's mid price before the swap from the
// pre-trade balances in the transaction and the pool's stored constants.
//
//	PumpSwap:      (quotePre + offset) / basePre
//	pump.fun curve: (lamportsPre − nonReserve + offSol) / (tokensPre + offTok)
//	Raydium v4 / CPMM: quotePre / basePre
func reservePrice(ctx context.Context, rpc *rpcClient, sw *Swap, pools *poolCache, solUSD float64) (float64, bool) {
	toQuote := func(sol float64) float64 {
		if sw.Quote == "SOL" {
			return sol
		}
		return sol * solUSD / sw.QuoteUSD
	}
	var p poolParams
	switch sw.Venue {
	case "raydium-v4", "raydium-cpmm":
		p = poolParams{ok: true}
	case "pumpswap", "pump-curve":
		pools.mu.Lock()
		cached, hit := pools.m[sw.PoolOwner]
		pools.mu.Unlock()
		if hit {
			p = cached
		} else {
			acc, err := rpc.account(ctx, sw.PoolOwner)
			if err != nil || acc == nil {
				return 0, false
			}
			d := acc.Data
			switch sw.Venue {
			case "pumpswap":
				if len(d) >= pumpSwapQuoteOffsetAt+8 {
					p = poolParams{quoteOffsetSOL: float64(binary.LittleEndian.Uint64(d[pumpSwapQuoteOffsetAt:])) / 1e9, ok: true}
				}
			case "pump-curve":
				if len(d) >= pumpCurveFieldsAt+40 {
					vTok := float64(binary.LittleEndian.Uint64(d[pumpCurveFieldsAt:]))
					vSol := float64(binary.LittleEndian.Uint64(d[pumpCurveFieldsAt+8:]))
					rTok := float64(binary.LittleEndian.Uint64(d[pumpCurveFieldsAt+16:]))
					rSol := float64(binary.LittleEndian.Uint64(d[pumpCurveFieldsAt+24:]))
					if vTok > rTok && vSol > rSol && float64(acc.Lamports) >= rSol {
						p = poolParams{
							quoteOffsetSOL: (vSol - rSol) / 1e9,
							tokenOffset:    (vTok - rTok) / 1e6, // pump.fun mints have 6 decimals
							nonReserveSOL:  (float64(acc.Lamports) - rSol) / 1e9,
							ok:             true,
						}
					}
				}
			}
			pools.mu.Lock()
			if len(pools.m) >= poolCacheMax {
				pools.m = map[string]poolParams{}
			}
			pools.m[sw.PoolOwner] = p
			pools.mu.Unlock()
		}
	default:
		return 0, false
	}
	if !p.ok {
		return 0, false
	}
	q := sw.PoolQuotePre - toQuote(p.nonReserveSOL) + toQuote(p.quoteOffsetSOL)
	b := sw.PoolBasePre + p.tokenOffset
	if q <= 0 || b <= 0 {
		return 0, false
	}
	return q / b, true
}

func prune(st *State, windowHours int) {
	cut := time.Now().Add(-time.Duration(windowHours) * time.Hour).Unix()
	kept := st.Swaps[:0]
	for _, s := range st.Swaps {
		if s.Time >= cut {
			kept = append(kept, s)
		}
	}
	st.Swaps = kept
	fails := st.Fails[:0]
	for _, f := range st.Fails {
		if f.Time >= cut {
			fails = append(fails, f)
		}
	}
	st.Fails = fails
	for k, bs := range st.Buckets {
		out := bs[:0]
		for _, b := range bs {
			if b.T >= cut {
				out = append(out, b)
			}
		}
		st.Buckets[k] = out
	}
}

// refOf: the row's reference price, 0 when unpriced.
func refOf(sw *Swap) float64 {
	if sw.RefPrice == nil {
		return 0
	}
	return *sw.RefPrice
}

// chainNames for the row names.
var chainNames = map[string]string{"bnb": "BNB", "robinhood": "Robinhood Chain", "base": "Base", "ethereum": "Ethereum", "arc": "Arc", "hyperevm": "HyperEVM"}

// cohort: the native terminals plus the cross-chain rows (one funding
// leg per app, one row per destination chain the app trades on).
func cohort() []Terminal {
	out := append([]Terminal{}, terminals...)
	for _, a := range xchainApps {
		out = append(out, Terminal{Slug: a.Slug + "-funding", Name: a.Name + " · funding", Kind: "app", Note: "Funding leg through Relay: the user pays on BNB, Robinhood Chain, Base, Ethereum or Arc and receives USDC or SOL on Solana (the token buy that follows is a native swap in the app's Solana row). Value given = the origin deposit plus its gas; terminal = the app fee the user paid; relay = what Relay kept (fees and spread); network = origin gas. Refunded and failed requests count in the fail rate."})
		for _, c := range originChains {
			out = append(out, Terminal{Slug: a.Slug + "-" + c.slug, Name: a.Name + " · " + chainNames[c.slug], Kind: "app", Note: "Trading on " + chainNames[c.slug] + " through Relay: the user pays in SOL on Solana, a Relay solver buys the token on " + chainNames[c.slug] + " and delivers it. Value given = the SOL sent (tx fee inside); value received = the tokens delivered, at the pool's state before the settlement swap (v2: reserves; v3 / v4: the price left by the previous swap on the pool); terminal = the app fee; relay = what Relay kept (fees, spread, destination gas); pool = the settlement swap's impact and LP fee."})
		}
	}
	for _, t := range evmTerminals {
		note := nativeNote
		if t.Note != "" {
			note += " " + t.Note
		}
		out = append(out, Terminal{Slug: t.Slug, Name: t.Name, Kind: t.Kind, Note: note})
	}
	return out
}

// evmSaleRow measures a request that sold a token on its origin chain and
// settled USDC / SOL on Solana: the tokens sold at the origin pool's state
// before the swap versus what reached the user on Solana.
func evmSaleRow(ctx context.Context, rpc *rpcClient, httpc *http.Client, t Terminal, x relayRequest, solUSD float64, gas map[string]float64) *Swap {
	var oc *originChain
	for i := range originChains {
		if originChains[i].slug == x.Chain {
			oc = &originChains[i]
		}
	}
	if oc == nil || x.InTx == "" || x.OutTx == "" || x.TokenIn == "" {
		return nil
	}
	outTx, err := rpc.transaction(ctx, x.OutTx)
	if err != nil || outTx == nil {
		return nil
	}
	recv := bridgeRow(t, x, outTx, solUSD, 0) // what reached the user on Solana, exact
	if recv == nil {
		return &Swap{Flag: "no_quote_received"}
	}
	s, err := priceEvmOriginSale(ctx, httpc, *oc, x.InTx, x.User, x.TokenIn, gas)
	if err != nil {
		return nil
	}
	q := recv.QuoteUSD
	sw := &Swap{Method: methodVersion, Sig: x.OutTx, Terminal: t.Slug, Slot: outTx.Slot, User: x.Recipient, Side: "sell", Quote: recv.Quote, Venue: s.Venue, Mint: x.TokenIn, Tokens: s.Tokens,
		Chain: x.Chain, RelayID: x.ID, InTx: x.InTx, QuoteUSD: q, Pools: s.Pools, Hops: s.Hops, PoolVault: s.Pool, Time: recv.Time}
	if sw.Venue == "" {
		sw.Venue = "relay"
	}
	sw.UserQ = recv.Tokens // quote received on Solana
	sw.TerminalQ = x.AppFeeUsd / q
	sw.NetworkQ = s.GasUSD / q // origin gas, paid by the user
	sw.PoolQ = s.PoolInUSD / q // quote the origin pool paid out
	relay := s.PoolInUSD - s.OtherUSD - x.AppFeeUsd - recv.Tokens*q
	if relay < 0 {
		relay = 0
	}
	sw.RelayQ = relay / q
	other := s.OtherUSD / q // a launchpad's protocol fee
	sw.OtherQ = &other
	if !s.Priced {
		sw.finalize(nil, 0, "")
		sw.Flag = "unpriced_" + s.Unpriced
		log.Printf("[evm] %s %s %s unpriced: %s", t.Slug, sw.Side, x.InTx+"/"+x.OutTx, s.Unpriced)
		return sw
	}
	ref := s.MidUSD / q
	sw.finalize(&ref, 0, s.RefSrc)
	implausibleSplit(sw)
	return sw
}

// evmRow measures a request that left Solana for a token on another
// chain: deposit on Solana, delivery and pool state on the destination.
func evmRow(ctx context.Context, rpc *rpcClient, httpc *http.Client, t Terminal, x relayRequest, solUSD float64, gas map[string]float64) *Swap {
	dc := chainByID(0)
	for i := range originChains {
		if originChains[i].slug == x.DestChain {
			dc = &originChains[i]
		}
	}
	if dc == nil || x.InTx == "" || x.OutTx == "" {
		return nil
	}
	inTx, err := rpc.transaction(ctx, x.InTx)
	if err != nil || inTx == nil {
		return nil
	}
	givenUSD, feeUSD, quote := solanaGiven(inTx, x.User, solUSD)
	if givenUSD <= 0 {
		return &Swap{Flag: "no_deposit"}
	}
	s, err := priceEvmSettlement(ctx, httpc, *dc, x.OutTx, x.Recipient, x.TokenOut, gas)
	if err != nil {
		return nil
	}
	q := 1.0
	if quote == "SOL" {
		q = solUSD
	}
	sw := &Swap{Method: methodVersion, Sig: x.OutTx, Terminal: t.Slug, Slot: inTx.Slot, User: x.Recipient, Side: "buy", Quote: quote, Venue: s.Venue, Mint: x.TokenOut, Tokens: s.Tokens,
		Chain: x.DestChain, RelayID: x.ID, InTx: x.InTx, QuoteUSD: q, Pools: s.Pools, Hops: s.Hops, PoolVault: s.Pool}
	if inTx.BlockTime != nil {
		sw.Time = *inTx.BlockTime
	}
	if sw.Venue == "" {
		sw.Venue = "relay"
	}
	sw.UserQ = givenUSD / q
	sw.TerminalQ = x.AppFeeUsd / q
	sw.NetworkQ = feeUSD / q
	sw.PoolQ = s.PoolInUSD / q
	relay := givenUSD - feeUSD - x.AppFeeUsd - s.PoolInUSD - s.OtherUSD
	if relay < 0 {
		relay = 0
	}
	sw.RelayQ = relay / q
	other := s.OtherUSD / q // a launchpad's protocol fee
	sw.OtherQ = &other
	if !s.Priced {
		sw.finalize(nil, 0, "")
		sw.Flag = "unpriced_" + s.Unpriced
		log.Printf("[evm] %s %s %s unpriced: %s", t.Slug, sw.Side, x.InTx+"/"+x.OutTx, s.Unpriced)
		if s.Unpriced == "" {
			sw.Flag = ""
		}
		return sw
	}
	ref := s.MidUSD / q
	sw.finalize(&ref, 0, s.RefSrc)
	if x.InIsToken {
		sw.Flag, sw.Priced = "origin_token", false
	}
	implausibleSplit(sw)
	return sw
}

// implausibleSplit keeps a row out of the statistics when its split
// cannot be right (a hop or quote matched to the wrong leg): a pool
// component below −10 % or a Relay component above 30 % of the trade.
func implausibleSplit(sw *Swap) {
	if sw.Priced && sw.PoolBps != nil && (*sw.PoolBps < -1000 || sw.RelayBps > 3000) {
		sw.Flag, sw.Priced = "split_implausible", false
	}
}

// productChains: the chain suffixes a row slug can carry; "funding" is
// the bridge leg of a cross-chain app, kept out of the product's pooled
// figure (it is not a swap).
var productChains = []string{"funding", "bnb", "robinhood", "base", "ethereum", "arc", "hyperevm"}

// productOf splits a row slug into the product and its chain
// ("fomo-bnb" → fomo, bnb; "trojan" → trojan, solana).
func productOf(slug string) (string, string) {
	for _, c := range productChains {
		if strings.HasSuffix(slug, "-"+c) {
			return strings.TrimSuffix(slug, "-"+c), c
		}
	}
	return slug, "solana"
}

var productNames = map[string]string{"fomo": "FOMO", "gmgn": "GMGN", "axiom": "Axiom", "banana-gun": "Banana Gun", "binance-wallet": "Binance Wallet", "basedbot": "BasedBot"}

// productTerminal: the identity of a product's pooled row.
func productTerminal(p string, rows []Terminal) Terminal {
	for _, t := range terminals {
		if t.Slug == p {
			return Terminal{Slug: p, Name: t.Name, Kind: t.Kind, Note: t.Note}
		}
	}
	name, kind, note := productNames[p], "app", ""
	if len(rows) > 0 {
		kind, note = rows[0].Kind, rows[0].Note
	}
	if name == "" {
		name = p
	}
	return Terminal{Slug: p, Name: name, Kind: kind, Note: note}
}

// compute builds one entry per row (a product on one chain, `chain` set)
// and one pooled entry per product over every chain it trades on
// (`chain: all`, the bench's headline, the funding legs left out).
func compute(st *State, minPriced, minRank int) []TerminalStats {
	out := make([]TerminalStats, 0, 2*(len(terminals)+len(xchainApps)))
	byProduct := map[string][]string{}
	rowsOf := map[string][]Terminal{}
	var products []string
	for _, t := range cohort() {
		ts, ok := statsFor(st, t, []string{t.Slug}, minPriced, minRank)
		if !ok {
			continue
		}
		ts.Product, ts.Chain = productOf(t.Slug)
		out = append(out, ts)
		if ts.Chain == "funding" {
			continue
		}
		if byProduct[ts.Product] == nil {
			products = append(products, ts.Product)
		}
		byProduct[ts.Product] = append(byProduct[ts.Product], t.Slug)
		rowsOf[ts.Product] = append(rowsOf[ts.Product], t)
	}
	for _, p := range products {
		ts, ok := statsFor(st, productTerminal(p, rowsOf[p]), byProduct[p], minPriced, minRank)
		if !ok {
			continue
		}
		ts.Product, ts.Chain = p, "all"
		out = append(out, ts)
	}
	// Ranked terminals first by median, then published-but-not-ranked by
	// median, then the rest by sample size.
	tier := func(ts TerminalStats) int {
		switch {
		case ts.Ranked && ts.Loss != nil:
			return 0
		case ts.Healthy && ts.Loss != nil:
			return 1
		}
		return 2
	}
	sort.SliceStable(out, func(i, j int) bool {
		ti, tj := tier(out[i]), tier(out[j])
		if ti != tj {
			return ti < tj
		}
		if ti == 2 {
			return out[i].Priced > out[j].Priced
		}
		return out[i].Loss.Median < out[j].Loss.Median
	})
	return out
}

// statsFor aggregates the window over the rows in slugs (one row, or a
// product's rows on every chain).
func statsFor(st *State, t Terminal, slugs []string, minPriced, minRank int) (TerminalStats, bool) {
	member := set(slugs...)
	rejects := map[string]int{}
	for _, slug := range slugs {
		for k, v := range st.Rejects[slug] {
			rejects[k] += v
		}
	}
	if len(rejects) == 0 {
		rejects = nil
	}
	{
		ts := TerminalStats{Slug: t.Slug, Name: t.Name, Kind: t.Kind, Note: t.Note, Components: map[string]float64{}, Venues: map[string]float64{}, Quotes: map[string]float64{}, Rejects: rejects}
		errs := map[string]int{}
		att, failed := 0, 0 // fail-rate base: the feed's attempts, or the block sample's on a native EVM row
		for _, slug := range slugs {
			native := isNativeEVM(slug)
			for _, b := range st.Buckets[slug] {
				ts.Seen += b.Seen
				ts.Failed += b.Failed
				ts.NonSwap += b.Other
				ts.SampSeen += b.SampSeen
				ts.SampFailed += b.SampFailed
				if native {
					att += b.SampSeen
					failed += b.SampFailed
				} else {
					att += b.Seen
					failed += b.Failed
				}
				for k, v := range b.Errs {
					errs[k] += v
				}
			}
		}
		ts.Attempts, ts.AttemptsFailed = att, failed
		if att >= 20 {
			fr := 100 * float64(failed) / float64(att)
			ts.FailRate = &fr // percent
		}
		if len(errs) > 0 {
			ts.FailReasons = topN(errs, 6)
		}
		var failFees []float64
		for _, f := range st.Fails {
			if member[f.Terminal] {
				failFees = append(failFees, f.FeeUSD) // 0 when sponsored: the user paid nothing
			}
		}
		ts.FailsSampled = len(failFees)
		if len(failFees) >= 5 {
			ts.FailCostUSD = quantiles(failFees, false)
		}
		var loss, pool, term, net, relay, other, trade, sandProfit []float64
		bySize := map[string][]float64{}
		byChain := map[string][]float64{}
		refSrc := map[string]int{}
		buys := 0
		refPool := 0
		venues := map[string]int{}
		quotes := map[string]int{}
		otherAgg := map[string]*OtherRecipient{}
		for _, s := range st.Swaps {
			if !member[s.Terminal] || s.Method != methodVersion {
				continue
			}
			if s.Scanned {
				ts.Scanned++
				if s.Sandwich != nil {
					ts.Sandwiched++
					sandProfit = append(sandProfit, s.Sandwich.ProfitBps)
				}
			}
			for k, v := range s.Others {
				if s.OtherQ == nil {
					break // multi-hop route: recipients include hop pools, not fees
				}
				r := otherAgg[k]
				if r == nil {
					r = &OtherRecipient{Pubkey: k}
					if pumpFeeRecipients[k] {
						r.Label = "pump.fun protocol fee"
					}
					otherAgg[k] = r
				}
				r.Count++
				r.Quote += v * s.QuoteUSD
			}
			ts.Parsed++
			term = append(term, s.TerminalBps)
			net = append(net, s.NetworkBps)
			if s.Chain != "" {
				relay = append(relay, s.RelayBps)
			}
			if s.OtherBps != nil {
				other = append(other, *s.OtherBps)
			}
			if s.TradeUSD > 0 {
				trade = append(trade, s.TradeUSD)
			}
			if s.Side == "buy" {
				buys++
			}
			venues[s.Venue]++
			quotes[s.Quote]++
			if s.Flag != "" {
				ts.Flagged++
			}
			if s.Priced && s.LossBps != nil {
				ts.Priced++
				if s.RefSrc == "pool" {
					refPool++
				}
				refSrc[s.RefSrc]++
				loss = append(loss, *s.LossBps)
				bySize[sizeBucket(s.TradeUSD)] = append(bySize[sizeBucket(s.TradeUSD)], *s.LossBps)
				if s.Chain != "" {
					byChain[s.Chain] = append(byChain[s.Chain], *s.LossBps)
				} else if len(slugs) > 1 {
					byChain["solana"] = append(byChain["solana"], *s.LossBps) // a product pooled over its chains
				}
				if s.PoolBps != nil {
					pool = append(pool, *s.PoolBps)
				}
			}
		}
		if ts.Parsed > 0 {
			ts.Components["terminal"] = median(term)
			ts.Components["network"] = median(net)
			if len(other) > 0 {
				ts.Components["other"] = median(other)
			}
			if len(relay) > 0 {
				ts.Components["relay"] = median(relay)
			}
			ts.BuySharePct = 100 * float64(buys) / float64(ts.Parsed)
			for v, c := range venues {
				ts.Venues[v] = 100 * float64(c) / float64(ts.Parsed)
			}
			for q, c := range quotes {
				ts.Quotes[q] = 100 * float64(c) / float64(ts.Parsed)
			}
		}
		if len(trade) > 0 {
			ts.TradeUSD = quantiles(trade, false)
		}
		// Expected burn on failed attempts per successful swap: with fail
		// rate r, a successful swap comes with r / (1 − r) failed ones on
		// average, each costing its fee.
		if ts.FailRate != nil && ts.FailCostUSD != nil && ts.TradeUSD != nil && ts.TradeUSD.Median > 0 && *ts.FailRate < 100 {
			r := *ts.FailRate / 100
			o := 1e4 * (r / (1 - r)) * ts.FailCostUSD.Median / ts.TradeUSD.Median
			ts.FailOverheadBps = &o
		}
		if ts.Priced > 0 {
			ts.Loss = quantiles(loss, true)
			if len(pool) > 0 {
				ts.Components["pool"] = median(pool)
			}
			ts.RefPoolPct = 100 * float64(refPool) / float64(ts.Priced)
			ts.RefSrcPct = map[string]float64{}
			for k, c := range refSrc {
				ts.RefSrcPct[k] = 100 * float64(c) / float64(ts.Priced)
			}
			ts.BySize = map[string]*Quantiles{}
			for b, v := range bySize {
				if len(v) >= 5 {
					ts.BySize[b] = quantiles(v, false)
				}
			}
			if len(byChain) > 0 {
				ts.ByChain = map[string]*Quantiles{}
				for c, v := range byChain {
					if len(v) >= 5 {
						ts.ByChain[c] = quantiles(v, true)
					}
				}
			}
		}
		if ts.Scanned >= 20 {
			p := 100 * float64(ts.Sandwiched) / float64(ts.Scanned)
			ts.SandwichPct = &p
		}
		if len(sandProfit) > 0 {
			ts.SandwichProfit = quantiles(sandProfit, false)
		}
		top := make([]OtherRecipient, 0, len(otherAgg))
		for _, r := range otherAgg {
			top = append(top, *r)
		}
		sort.Slice(top, func(i, j int) bool { return top[i].Quote > top[j].Quote })
		if len(top) > 8 {
			top = top[:8]
		}
		ts.OtherTop = top
		ts.Healthy = ts.Priced >= minPriced
		ts.Ranked = ts.Priced >= minRank
		if len(slugs) == 1 && strings.Contains(t.Slug, "-") && isXchainRow(t.Slug) && ts.Seen == 0 && ts.Parsed == 0 {
			return ts, false // a cross-chain row nobody used in the window
		}
		return ts, true
	}
}

func isXchainRow(slug string) bool {
	for _, r := range xchainRows() {
		if r == slug {
			return true
		}
	}
	for _, t := range evmTerminals {
		if t.Slug == slug {
			return true
		}
	}
	return false
}

func topN(m map[string]int, n int) map[string]int {
	type kv struct {
		k string
		v int
	}
	all := make([]kv, 0, len(m))
	for k, v := range m {
		all = append(all, kv{k, v})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].v > all[j].v })
	out := map[string]int{}
	for i, e := range all {
		if i >= n {
			break
		}
		out[e.k] = e.v
	}
	return out
}

func publishGauges(stats []TerminalStats) {
	for _, ts := range stats {
		if ts.Loss != nil && ts.Healthy {
			gLoss.WithLabelValues(ts.Product, ts.Chain, "median").Set(ts.Loss.Median)
			gLoss.WithLabelValues(ts.Product, ts.Chain, "p90").Set(ts.Loss.P90)
			if ts.Loss.CILo != nil && ts.Loss.CIHi != nil {
				gLoss.WithLabelValues(ts.Product, ts.Chain, "ci_lo").Set(*ts.Loss.CILo)
				gLoss.WithLabelValues(ts.Product, ts.Chain, "ci_hi").Set(*ts.Loss.CIHi)
			}
		} else {
			gLoss.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
		}
		for c, v := range ts.Components {
			gComponent.WithLabelValues(ts.Product, ts.Chain, c).Set(v)
		}
		if ts.FailRate != nil {
			gFail.WithLabelValues(ts.Product, ts.Chain).Set(*ts.FailRate) // already percent
		} else {
			gFail.DeleteLabelValues(ts.Product, ts.Chain)
		}
		gSamples.WithLabelValues(ts.Product, ts.Chain, "seen").Set(float64(ts.Seen))
		gSamples.WithLabelValues(ts.Product, ts.Chain, "parsed").Set(float64(ts.Parsed))
		gSamples.WithLabelValues(ts.Product, ts.Chain, "priced").Set(float64(ts.Priced))
		if ts.TradeUSD != nil {
			gTrade.WithLabelValues(ts.Product, ts.Chain, "median").Set(ts.TradeUSD.Median)
			gTrade.WithLabelValues(ts.Product, ts.Chain, "p90").Set(ts.TradeUSD.P90)
		}
		gVenue.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
		for v, p := range ts.Venues {
			gVenue.WithLabelValues(ts.Product, ts.Chain, v).Set(p)
		}
		gBuy.WithLabelValues(ts.Product, ts.Chain).Set(ts.BuySharePct)
		if ts.SandwichPct != nil {
			gSandwich.WithLabelValues(ts.Product, ts.Chain).Set(*ts.SandwichPct)
		} else {
			gSandwich.DeleteLabelValues(ts.Product, ts.Chain)
		}
		if ts.SandwichProfit != nil {
			gSandwichProfit.WithLabelValues(ts.Product, ts.Chain).Set(ts.SandwichProfit.Median)
		} else {
			gSandwichProfit.DeleteLabelValues(ts.Product, ts.Chain)
		}
		gLossSize.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
		for b, q := range ts.BySize {
			gLossSize.WithLabelValues(ts.Product, ts.Chain, b).Set(q.Median)
		}
		gLossChain.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
		for c, q := range ts.ByChain {
			gLossChain.WithLabelValues(ts.Product, ts.Chain, c).Set(q.Median)
		}
		if ts.FailCostUSD != nil {
			gFailCost.WithLabelValues(ts.Product, ts.Chain).Set(ts.FailCostUSD.Median)
		} else {
			gFailCost.DeleteLabelValues(ts.Product, ts.Chain)
		}
		if ts.FailOverheadBps != nil {
			gFailOverhead.WithLabelValues(ts.Product, ts.Chain).Set(*ts.FailOverheadBps)
		} else {
			gFailOverhead.DeleteLabelValues(ts.Product, ts.Chain)
		}
		gHealth.WithLabelValues(ts.Product, ts.Chain).Set(b2f(ts.Healthy))
		gRanked.WithLabelValues(ts.Product, ts.Chain).Set(b2f(ts.Ranked))
	}
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func sizeBucket(usd float64) string {
	switch {
	case usd < 25:
		return "under25"
	case usd < 250:
		return "25to250"
	}
	return "over250"
}

func recent(st *State, n int) []Swap {
	if len(st.Swaps) <= n {
		return append([]Swap(nil), st.Swaps...)
	}
	return append([]Swap(nil), st.Swaps[len(st.Swaps)-n:]...)
}

// quantiles: median and p90; with ci, the 95 % bootstrap interval of the
// median (300 resamples), so a difference between two terminals can be
// read against the sampling noise.
func quantiles(v []float64, ci bool) *Quantiles {
	if len(v) == 0 {
		return nil
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	q := &Quantiles{Median: pct(s, 0.5), P90: pct(s, 0.9), N: len(s)}
	if ci && len(s) >= 5 {
		const rounds = 300
		meds := make([]float64, rounds)
		tmp := make([]float64, len(s))
		for r := range meds {
			for i := range tmp {
				tmp[i] = s[rand.Intn(len(s))]
			}
			sort.Float64s(tmp)
			meds[r] = pct(tmp, 0.5)
		}
		sort.Float64s(meds)
		lo, hi := pct(meds, 0.025), pct(meds, 0.975)
		q.CILo, q.CIHi = &lo, &hi
	}
	return q
}

func median(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	return pct(s, 0.5)
}

// pct on a sorted slice, linear interpolation.
func pct(s []float64, p float64) float64 {
	if len(s) == 1 {
		return s[0]
	}
	pos := p * float64(len(s)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	return s[lo] + (s[hi]-s[lo])*(pos-float64(lo))
}

func loadState(path string) *State {
	empty := func() *State {
		return &State{Buckets: map[string][]minuteBucket{}, Rejects: map[string]map[string]int{}, Cursors: map[string]*walletCursor{}}
	}
	st := empty()
	if path == "" {
		return st
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return st
	}
	if err := json.Unmarshal(b, st); err != nil {
		log.Printf("[state] %s unreadable, starting empty: %v", path, err)
		return empty()
	}
	if st.Buckets == nil {
		st.Buckets = map[string][]minuteBucket{}
	}
	if st.Rejects == nil {
		st.Rejects = map[string]map[string]int{}
	}
	if st.Cursors == nil {
		st.Cursors = map[string]*walletCursor{}
	}
	// Rows of another method version never enter the statistics; drop
	// them so the window holds one method only.
	// PURGE_EVM_BEFORE (unix seconds) drops the EVM rows older than that
	// once, after a pricing fix that changed their split (the Solana rows
	// keep their method version and stay).
	purgeBefore := int64(envInt("PURGE_EVM_BEFORE", 0))
	kept := st.Swaps[:0]
	dropped, purged := 0, 0
	for _, s := range st.Swaps {
		if s.Method != methodVersion {
			dropped++
			continue
		}
		if purgeBefore > 0 && s.Chain != "" && s.Time < purgeBefore {
			purged++
			continue
		}
		kept = append(kept, s)
	}
	st.Swaps = kept
	log.Printf("[state] loaded %d swaps from %s (%d of another method version dropped, %d EVM rows purged)", len(st.Swaps), path, dropped, purged)
	return st
}

func writeAtomic(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
