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
	"math/big"
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

// Sample floors for the per-size views, set from MIN_PRICED_SIZE and
// MIN_RANK_SIZE at startup.
var minPricedSize, minRankSize = 20, 40

var (
	gLoss = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_loss_bps", Help: "Value lost per swap vs the pool's pre-trade state, basis points of the trade (priced samples, rolling window); stat=median|p90|p99|ci_lo|ci_hi; bucket=all|under25|25to250|over250 (trade size in USD)",
	}, []string{"terminal", "chain", "stat", "bucket"})
	gLossExFee = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_loss_ex_fee_bps", Help: "Value lost per swap with the app's own fee removed, basis points of the trade: execution quality alone, network, pool and protocol costs still inside. Subtracted per swap, then the median, because median(loss) - median(fee) is a different statistic wherever an app's fee varies across its own swaps. stat=median|p90|p99|ci_lo|ci_hi",
	}, []string{"terminal", "chain", "stat", "bucket"})
	gComponent = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_component_bps", Help: "Cost component per swap, basis points of the trade: the median on a chain row; on All chains of a multi-chain product, each chain's median weighted by its flow; bucket=all, or a trade-size bucket as a plain median over its swaps",
	}, []string{"terminal", "chain", "component", "bucket"})
	gFail = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_fail_rate_pct", Help: "Share of the terminal's swap attempts that failed on-chain, percent (rolling window, every attempt the feed saw)",
	}, []string{"terminal", "chain"})
	gSamples = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_sample_size", Help: "Samples in the window: seen (swap attempts), parsed (swaps), priced (with a loss figure)",
	}, []string{"terminal", "chain", "kind", "bucket"})
	gTrade = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_trade_usd", Help: "Sampled trade size in USD",
	}, []string{"terminal", "chain", "stat", "bucket"})
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
		Name: "tfq_loss_bps_chain", Help: "A pooled product's median loss per swap by chain (origin = solana, bnb, robinhood, base, ethereum, arc, hyperevm)",
	}, []string{"terminal", "chain", "origin"})
	gHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_health", Help: "1 when the entry has at least MIN_PRICED priced samples in the window (a product on one chain: half that), its main chain is not still filling, and its sample is not one side only with no fee",
	}, []string{"terminal", "chain", "bucket"})
	gRanked = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_ranked", Help: "1 when the terminal has at least MIN_RANK priced samples (its median is stable enough to rank)",
	}, []string{"terminal", "chain", "bucket"})
	gFailCost = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_fail_cost_usd", Help: "Median transaction fee paid on a failed swap attempt, USD (sampled failed attempts, rolling window)",
	}, []string{"terminal", "chain"})
	gFailOverhead = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_fail_overhead_bps", Help: "Expected fee burnt on failed attempts per successful swap: fail rate / (1 − fail rate) × median failed-attempt fee, basis points of the median trade",
	}, []string{"terminal", "chain"})
	gLostUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_lost_usd", Help: "Median loss applied to the median trade: dollars the typical swap on the terminal loses (median trade × median loss)",
	}, []string{"terminal", "chain", "bucket"})
	gRefresh  = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_last_refresh_unix", Help: "Last successful tick"})
	gFeed     = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_feed_up", Help: "1 when the WebSocket feed is connected and heard something in the last two minutes"})
	// Per-chain health of the EVM log feed. This existed only inside the
	// feed struct, so BNB's read nothing for days behind a green
	// tfq_feed_up, which covers the Solana WebSocket alone.
	gNativeUp = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "tfq_native_feed_up", Help: "1 when the chain's eth_getLogs feed answered its last poll"}, []string{"chain"})
	// How far behind the head each chain's cursor sits. A counter of
	// skipped blocks cannot show a stuck feed (it re-counts the same gap
	// every poll: BNB logged 250,834,117 skipped blocks in 24 h on a chain
	// that makes about 115,000). A lag that stays flat at 630,000 can.
	gNativeLag = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "tfq_native_lag_blocks", Help: "Blocks between the chain's head and the log feed's cursor after the last poll"}, []string{"chain"})
	gUnpriced = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_unpriced_share", Help: "Share of the window's drawn swaps that could not be valued at the pool's state (routes without a quote leg, undecoded venues); the published figure rests on the rest",
	}, []string{"terminal", "chain"})
	gRelayFeed = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_relay_feed_up", Help: "1 when Relay's requests API answered the last polling round (the cross-chain rows' feed)"})
	gSol       = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_sol_usd", Help: "SOL/USD used for sizing"})
	cCalls     = prometheus.NewCounter(prometheus.CounterOpts{Name: "tfq_rpc_calls_total", Help: "RPC calls"})
	cSkipped   = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "tfq_native_skipped_blocks_total", Help: "Blocks the EVM log feed skipped when its cursor fell over 2,000 blocks behind the head (a restart, a slow node): neither read nor sampled"}, []string{"chain"})
	cErrors    = prometheus.NewCounter(prometheus.CounterOpts{Name: "tfq_rpc_errors_total", Help: "RPC errors and rate limits"})
)

func init() {
	prometheus.MustRegister(gNativeUp, gNativeLag, gLoss, gLossExFee, gComponent, gFail, gSamples, gTrade, gVenue, gBuy, gSandwich, gSandwichProfit, gLossSize, gLossChain, gHealth, gRanked, gFailCost, gFailOverhead, gLostUSD, gUnpriced, gRefresh, gFeed, gRelayFeed, gSol, cCalls, cErrors, cSkipped)
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
	SampBlocks int `json:"sb,omitempty"` // blocks read in full this minute
	SpanBlocks int `json:"sp,omitempty"` // blocks the chain made over the polled range
	// Rej: draws rejected this minute, by reason (windowed with the bucket,
	// unlike the legacy State.Rejects which grew for the life of the file).
	Rej map[string]int `json:"rej,omitempty"`
}

// recordSample adds a block sample's attempts and reverts (native EVM)
// and the sample's coverage: blocks read over blocks in the polled range.
func (st *State) recordSample(slug string, now int64, seen, failed, blocks, span int) {
	if seen == 0 && blocks == 0 {
		return
	}
	m := now - now%60
	b := st.Buckets[slug]
	if len(b) == 0 || b[len(b)-1].T != m {
		b = append(b, minuteBucket{T: m})
	}
	b[len(b)-1].SampSeen += seen
	b[len(b)-1].SampFailed += failed
	b[len(b)-1].SampBlocks += blocks
	b[len(b)-1].SpanBlocks += span
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
	Swaps       []Swap                      `json:"swaps"`
	Fails       []failSample                `json:"fails"`
	Buckets     map[string][]minuteBucket   `json:"buckets"`                // terminal -> per-minute feed counts
	Rejects     map[string]map[string]int   `json:"rejects"`                // terminal -> reason -> count (window not enforced; informative)
	Cursors     map[string]*walletCursor    `json:"cursors"`                // wallet -> cursor (polling fallback)
	EvmCursor   map[string]int64            `json:"evm_cursor,omitempty"`   // chain -> last block scanned for the native EVM terminals
	// chain -> unix time its log feed last failed, absent while it reads.
	// Without it a chain the harness cannot read is indistinguishable from
	// a chain nobody trades on, and its rows vanish from the board rather
	// than saying they have no data.
	FeedDown    map[string]int64            `json:"feed_down,omitempty"`
	Learned     map[string]*Learned         `json:"learned,omitempty"`      // terminal -> fee wallets / routers learned from the chain (discover.go)
	Funded      map[string]map[string]int64 `json:"funded,omitempty"`       // app -> EVM wallet it funded through Relay -> last seen (identifies its users on a shared router)
	RelayNewest map[string]int64            `json:"relay_newest,omitempty"` // app:origin -> created of the newest Relay request counted (the walk after a restart stops there instead of re-counting a day)
	Resampling  map[string]int64            `json:"resampling,omitempty"`   // slug -> unix time its rows were purged (the entry says it is re-sampling while its window refills)
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
	/** The same, with the terminal's own fee removed per swap: execution
	  * quality alone. Network, pool and protocol costs stay inside — how a
	  * swap is routed is the app's doing, what it charges for it is not. */
	LossExFee   *Quantiles         `json:"loss_ex_fee_bps,omitempty"`
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
	/** The whole row again per trade-size bucket: loss, the split, trade size, sample count. */
	SizeSplit map[string]*SizeStats `json:"size_split,omitempty"`
	/** Cross-chain apps: loss by origin chain (bnb, robinhood, base, ethereum, arc), with the median's interval. */
	ByChain map[string]*Quantiles `json:"by_chain,omitempty"`
	/** Largest "other" recipients over the window, for audit: pubkey, label when known, count, quote received in USD. */
	OtherTop []OtherRecipient `json:"other_top,omitempty"`
	/** Healthy: at least MIN_PRICED priced swaps (figure published). Ranked: at least MIN_RANK (figure ranked). */
	Healthy bool `json:"healthy"`
	Ranked  bool `json:"ranked"`
	// LoopShare: swaps left out as farming loops over parsed plus left out (rows with DropLoops).
	LoopShare float64 `json:"loop_share,omitempty"`
	// NEff: a pooled entry's effective sample size, (Σw)² / Σw² over the priced swaps' weights.
	NEff float64 `json:"n_eff,omitempty"`
	// UnpricedShare: the window's drawn swaps left unpriced over drawn swaps, informative.
	UnpricedShare float64 `json:"unpriced_share,omitempty"`
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
	P99    float64  `json:"p99"`
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
	Recent        []PublicSwap    `json:"recent"`
	/** Cohort discovery: fee wallets and routers learned from the chain, evidence per platform, unattributed fee-like recipients. */
	Discovery *Discovery `json:"discovery,omitempty"`
}

func main() {
	// SOLANA_RPC: comma-separated endpoints tried in order (the next on a
	// rate limit or a transport error); the Helius key, when set, joins the
	// list after them, the public node last. Production: Chainstack's
	// shared Solana node first (a paid node with no per-call budget), then
	// Alchemy's free app for the overflow, then Helius (free tier, 1 M
	// credits a month: the bench alone used 0.9 M when it was primary).
	var rpcURLs []string
	for _, u := range strings.Split(os.Getenv("SOLANA_RPC"), ",") {
		if u = strings.TrimSpace(u); u != "" {
			rpcURLs = append(rpcURLs, u)
		}
	}
	if k := os.Getenv("HELIUS_API_KEY"); k != "" {
		rpcURLs = append(rpcURLs, "https://mainnet.helius-rpc.com/?api-key="+k)
	}
	rpcURLs = append(rpcURLs, "https://api.mainnet-beta.solana.com")
	rpcURL := rpcURLs[0]
	log.Printf("solana reads: %d endpoint(s), primary %s", len(rpcURLs), redactURL(rpcURL, rpcURL))
	tick := time.Duration(envInt("TICK_SECONDS", 60)) * time.Second
	sandwichOn = envInt("SANDWICH", 1) == 1
	nativePollEvery = max(1, envInt("NATIVE_POLL_EVERY", 1))
	if v := os.Getenv("FAIL_SCAN_BLOCKS"); v != "" { // e.g. "bnb=3,robinhood=0,base=2,ethereum=1"
		for _, kv := range strings.Split(v, ",") {
			if k, n, ok := strings.Cut(strings.TrimSpace(kv), "="); ok {
				if i, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
					failScanBlocks[strings.TrimSpace(k)] = i
				}
			}
		}
	}
	dailyTarget := envInt("DAILY_TARGET", 400) // swaps read per terminal per day
	perTick := float64(dailyTarget) * tick.Seconds() / 86400
	evmDailyTarget := envInt("EVM_DAILY_TARGET", 1000) // the Relay and native EVM rows: their own rate (one chain each)
	perTickEVM := float64(evmDailyTarget) * tick.Seconds() / 86400
	perTickFail := float64(envInt("FAIL_DAILY_TARGET", 40)) * tick.Seconds() / 86400 // failed attempts read per terminal per day
	windowHours := envInt("WINDOW_HOURS", 24)
	minPriced := envInt("MIN_PRICED", 50)
	minRank := envInt("MIN_RANK", 100)
	// A size bucket holds roughly a third of a terminal's sample, so it
	// gets its own floors rather than silently failing the whole-row ones
	// and leaving every size view blank. Lower, and said out loud: a
	// bucket under MIN_RANK_SIZE publishes its figure unranked, which the
	// site shows as provisional.
	minPricedSize = envInt("MIN_PRICED_SIZE", 20)
	minRankSize = envInt("MIN_RANK_SIZE", 40)
	useWS := envInt("WS", 1) == 1
	minTradeUSD = float64(envInt("MIN_TRADE_USD", 2))
	stateFile := os.Getenv("STATE_FILE")
	publicFile := os.Getenv("HISTORY_FILE_PUBLIC")
	addr := os.Getenv("METRICS_ADDR")
	if addr == "" {
		addr = ":2112"
	}
	log.Printf("OpenChainBench #268: terminal fill quality, method v%d, %d Solana terminals | tick=%s target=%d swaps/terminal/day (EVM rows %d) window=%dh publish>=%d rank>=%d ws=%v", methodVersion, len(terminals), tick, dailyTarget, evmDailyTarget, windowHours, minPriced, minRank, useWS)

	// Redirects are not followed: a public RPC that answers a heavy query
	// with a redirect to a private address (seen on Robinhood Chain's
	// eth_getLogs) would otherwise hang every call for the whole timeout.
	httpc := &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	rps := envInt("RPC_RPS", 8)
	rpc := &rpcClient{url: rpcURL, urls: rpcURLs, http: httpc, calls: cCalls.Inc, errors: cErrors.Inc, minGap: time.Second / time.Duration(max(rps, 1))}

	applyRPCOverrides()
	st := loadState(stateFile)
	applyLearned(st)
	seedFunded(st)
	pools := &poolCache{m: map[string]poolParams{}}
	repriced := false
	quota := map[string]float64{}
	failQuota := map[string]float64{}
	activity := map[string]float64{} // running successful attempts per tick, per terminal
	var fd *feed
	if useWS {
		// WS_URL lets the feed run on another endpoint than the reads (the
		// public wss://api.mainnet-beta.solana.com is free and keyless).
		wsURL := os.Getenv("WS_URL")
		if wsURL == "" {
			wsURL = "wss://api.mainnet-beta.solana.com"
		}
		fd = newFeed(wsURL)
		fd.feeTx = map[string]bool{}
		for _, t := range terminals {
			if t.FeeTx {
				fd.feeTx[t.Slug] = true
			}
		}
		go fd.run(context.Background())
	}
	if st.EvmCursor == nil {
		st.EvmCursor = map[string]int64{}
	}
	if st.FeedDown == nil {
		st.FeedDown = map[string]int64{}
	}
	nf := newNativeFeed(httpc, st.EvmCursor, st.FeedDown)
	xf := newXfeed(httpc, st.RelayNewest)
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
	// The Relay seed walk (up to 3 min) runs with /metrics already served:
	// Prometheus never sees the restart as a scrape gap.
	{
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		seedFundedFromRelay(sctx, httpc, st)
		cancel()
	}

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
		if !repriced {
			repriced = true
			repriceVenues(ctx, rpc, st, pools, sol, time.Now().Unix())
		}
		added, seen := sample(ctx, rpc, st, sol, pools, fd, quota, failQuota, activity, perTick, perTickFail)
		gas := gasPrices(ctx, httpc)
		added += sampleXchain(ctx, rpc, httpc, st, sol, gas, xf, pools, quota, perTickEVM)
		a2, s2 := sampleNative(ctx, httpc, st, nf, gas, quota, perTickEVM)
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
			Method:    "Random sample of the swaps each terminal routed (Solana: the fee-wallet and program feed; EVM: the terminals' routers and blocks read in full; cross-chain: Relay's public requests), read on-chain; loss = 1 − value received at the pool's pre-trade state / value given, basis points of the trade; the split (terminal, network, other, pool, relay) is exact from balance deltas; a pooled product weighs each chain by its flow.",
			Terminals: stats, Recent: publicSwaps(recent(st, recentMinPerTerminal, recentTotal, flowOf(stats)), flowOf(stats)), Discovery: disc,
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
		// The quota accrues every tick, quiet ticks included (a sparse
		// terminal, one swap every few minutes, would otherwise never reach
		// a whole draw: Banana Gun drew about one an hour on 2,266 attempts
		// a day), weighted by the tick's activity against its running mean
		// within [0.5, 2] so a burst neither starves the next hour nor
		// overdraws the tick.
		w := 1.0
		if a := activity[t.Slug]; a > 0 && okCount > 0 {
			w = math.Min(2, math.Max(0.5, okCount/a))
		}
		if okCount > 0 {
			if activity[t.Slug] == 0 {
				activity[t.Slug] = okCount
			} else {
				activity[t.Slug] = 0.9*activity[t.Slug] + 0.1*okCount
			}
		}
		quota[t.Slug] += perTick * w
		if cap := math.Max(3*perTick, 10); quota[t.Slug] > cap { // a bursty sparse terminal keeps its accrued draws
			quota[t.Slug] = cap
		}
		if okCount == 0 {
			continue
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
				st.reject(t.Slug, "unreadable")
				continue
			}
			var sw *Swap
			var reject parseReject
			if t.FeeTx {
				sw, tx, reject = feeTxSwap(ctx, rpc, t, s.Signature, tx, solUSD)
			} else {
				sw, reject = parseSwap(t, s.Signature, tx, solUSD, "")
			}
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
	now := time.Now().Unix()
	m := now - now%60
	b := st.Buckets[slug]
	if len(b) == 0 || b[len(b)-1].T != m {
		b = append(b, minuteBucket{T: m})
	}
	last := &b[len(b)-1]
	if last.Rej == nil {
		last.Rej = map[string]int{}
	}
	last.Rej[string(r)]++
	st.Buckets[slug] = b
}

// priceSwap sets the swap's reference price and runs the sandwich screen:
// the exact pre-trade mid from the pool's reserves when the route is one
// constant-product pool, else from the venue's own swap event (Launchpad,
// Meteora DLMM), else the previous trade on the pool (at most 60 s
// earlier); the pool neighbourhood is read anyway for the screen.
func priceSwap(ctx context.Context, rpc *rpcClient, sw *Swap, tx *parsedTx, pools *poolCache, solUSD float64, now int64) {
	// The split guard, on every exit: this function returns from four
	// places and prices in three, and it had never applied it at all —
	// implausibleSplit was wired into the EVM paths only, so a Solana row
	// whose named costs exceeded what the trade lost was published like
	// any other. Deferred rather than repeated, so a new exit cannot skip
	// it again.
	defer implausibleSplit(sw)
	// The venue's own event first, where the vaults do not describe the
	// curve: pump.fun's virtual reserves are not constants, so the cached
	// account constants can be stale, and a Raydium CP-Swap vault holds
	// protocol, fund and creator fees that the curve excludes — its event
	// reports the reserves it actually used.
	if sw.Venue == "pump-curve" || sw.Venue == "raydium-cpmm" {
		if p, ok := eventMid(ctx, rpc, sw, tx, solUSD); ok {
			sw.finalize(&p, 0, "reserves")
		}
	}
	if sw.RefSrc == "" && sw.PoolBasePre > 0 && sw.PoolQuotePre > 0 {
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
	// The pool neighbourhood costs one signature list plus a transaction
	// read; with the screen off it is only read when the reference is
	// still missing (the previous-trade fallback).
	if !sandwichOn && sw.RefSrc != "" {
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
	if !sandwichOn {
		return
	}
	if sd, ok := screenSandwich(ctx, rpc, sw, nb, prevTx, solUSD, now); ok {
		sw.Scanned = true
		sw.Sandwich = sd
		sw.BlockPoolTxs = len(nb.prev)
	}
}

// sandwichOn: SANDWICH=0 turns the neighbour screen off (it is not a
// published column; the reads it costs are about a fifth of the Solana
// budget). Set at start.
var sandwichOn = true

// sampleXchain drains the Relay feed: counts every final request of each
// cross-chain app for its fail rate, draws the tick's quota of successful
// token settlements on Solana and measures them (see xchain.go).
func sampleXchain(ctx context.Context, rpc *rpcClient, httpc *http.Client, st *State, solUSD float64, gas map[string]float64, xf *xfeed, pools *poolCache, quota map[string]float64, perTick float64) (added int) {
	if xf == nil || !xf.healthy() {
		return 0
	}
	now := time.Now().Unix()
	st.RelayNewest = xf.newestSnapshot()
	for app, ws := range xf.drainFunded() {
		if st.Funded == nil {
			st.Funded = map[string]map[string]int64{}
		}
		if st.Funded[app] == nil {
			st.Funded[app] = map[string]int64{}
		}
		for w, t := range ws {
			st.Funded[app][w] = t
		}
	}
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
		measured := map[string]bool{}
		for _, s := range st.Swaps {
			if s.RelayID != "" {
				measured[s.RelayID] = true
			}
		}
		for _, x := range sample[:n] {
			if measured[x.ID] {
				continue // already in the window (re-walked after a restart)
			}
			if x.DestChain != "" || (x.InIsToken && x.Chain != "solana") {
				// Leaving Solana for a token elsewhere (the deposit is read on
				// Solana, the delivery and the pool's state on the destination),
				// or a token sold on the origin chain and settled on Solana.
				var sw *Swap
				if x.Funding {
					sw = evmFundingRow(ctx, rpc, t, x, solUSD, gas)
				} else if x.DestChain != "" {
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
				sw.RelayQ = (x.RelayFeeUsd + relayDeclaredFees(x)) / q
				// Neither field present: unknown, not zero.
				sw.RelayUnknown = x.RelayFeeUsd == 0 && relayDeclaredFees(x) == 0
				sw.NetworkQ = (gasUSD + x.DestGasUsd) / q
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
// failRetry: failed attempts drawn but not readable yet, per terminal, read again next tick.
var failRetry = map[string][]sigInfo{}

func sampleFails(ctx context.Context, rpc *rpcClient, st *State, t Terminal, failed []sigInfo, failQuota map[string]float64, perTickFail, solUSD float64, now int64) {
	// The quota accrues every tick, failures seen or not (a terminal failing
	// once every few minutes would otherwise never reach a whole sample),
	// starts at one draw so a restart does not blank the figure for 36
	// ticks, and a read that fails (the transaction not yet served at the
	// commitment asked) gives its share back for the next tick.
	if _, ok := failQuota[t.Slug]; !ok {
		failQuota[t.Slug] = 1
	}
	failQuota[t.Slug] += perTickFail
	if cap := math.Max(3*perTickFail, 2); failQuota[t.Slug] > cap {
		failQuota[t.Slug] = cap
	}
	// A failed attempt drawn from the tick's feed is often not served yet at
	// the commitment asked (the notification is seconds old): the draw is
	// kept and read again on the next tick instead of being dropped.
	rand.Shuffle(len(failed), func(i, j int) { failed[i], failed[j] = failed[j], failed[i] })
	failed = append(append([]sigInfo{}, failRetry[t.Slug]...), failed...)
	failRetry[t.Slug] = nil
	if len(failed) == 0 {
		return
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
	for _, s := range failed[:n] {
		tx, err := rpc.transaction(ctx, s.Signature)
		if err != nil || tx == nil {
			failQuota[t.Slug] += 1
			if len(failRetry[t.Slug]) < 8 {
				failRetry[t.Slug] = append(failRetry[t.Slug], s)
			}
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
		out = append(out, Terminal{Slug: a.Slug + "-funding", Name: a.Name + " · funding", Kind: "app", Note: "Funding legs through Relay, either way: the user pays on BNB, Robinhood Chain, Base, Ethereum or Arc and receives USDC or SOL on Solana (FOMO; the token buy that follows is a native swap in the app's Solana row), or moves funds between the Solana and EVM wallets of the same app account, either direction (BasedBot: an in-app bridge, not a deposit to trade). Value given = the origin deposit plus its gas; received = the amount delivered; terminal = the app fee the user paid; network = origin gas plus the destination gas Relay charged (its fee breakdown); relay = the rest of what Relay kept (fixed and price fees, the solver's spread). Refunded and failed requests count in the fail rate. Out of the product's pooled figure: a bridge, not a fill."})
		if a.FundingOnly {
			continue
		}
		for _, c := range originChains {
			out = append(out, Terminal{Slug: a.Slug + "-" + c.slug, Name: a.Name + " · " + chainNames[c.slug], Kind: "app", Note: "Trading on " + chainNames[c.slug] + " through Relay: the user pays in USDC or SOL from the app wallet on Solana, a Relay solver buys the token on " + chainNames[c.slug] + " and delivers it. Value given = the SOL sent (tx fee inside); value received = the tokens delivered, at the pool's state before the settlement swap (v2: reserves; v3 / v4: the price left by the previous swap on the pool); terminal = the app fee; relay = what Relay kept (fees, spread, destination gas); pool = the settlement swap's impact and LP fee."})
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

// relayDeclaredFees: Relay's fixed and price fees (USD) from its breakdown,
// for the rows whose relay figure is not a residual.
func relayDeclaredFees(x relayRequest) float64 {
	return x.RelayFixedUsd
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
	sw.NetworkQ = (s.GasUSD + x.DestGasUsd) / q // origin gas paid by the user, plus the destination gas Relay charged
	sw.PoolQ = s.PoolInUSD / q                  // quote the origin pool paid out
	relay := s.PoolInUSD - s.OtherUSD - x.AppFeeUsd - recv.Tokens*q - x.DestGasUsd
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

// seedFunded rebuilds the funded-wallet sets from the window's funding legs
// (the users an app funded on another chain: their trades on that chain's
// shared router are the app's) and drops entries older than two weeks.
func seedFunded(st *State) {
	if st.Funded == nil {
		st.Funded = map[string]map[string]int64{}
	}
	for _, s := range st.Swaps {
		if !strings.HasSuffix(s.Terminal, "-funding") || s.Chain == "" || !strings.HasPrefix(s.User, "0x") {
			continue
		}
		app := strings.TrimSuffix(s.Terminal, "-funding")
		if st.Funded[app] == nil {
			st.Funded[app] = map[string]int64{}
		}
		if w := strings.ToLower(s.User); st.Funded[app][w] < s.Time {
			st.Funded[app][w] = s.Time
		}
	}
	cut := time.Now().Add(-14 * 24 * time.Hour).Unix()
	for app, m := range st.Funded {
		for w, t := range m {
			if t < cut {
				delete(m, w)
			}
		}
		if len(m) == 0 {
			delete(st.Funded, app)
		}
	}
}

// evmFundingRow measures a request that left Solana as the gas coin (or
// Arc's USDC) delivered to the user's wallet on another chain: a funding
// leg the other way round (BasedBot funds its users' Robinhood Chain,
// BNB, Base and Ethereum wallets this way, with no app fee). Value given
// = the SOL sent, read on Solana (its fee apart); received = the native
// amount delivered at the exchange's price; what Relay kept is the rest.
func evmFundingRow(ctx context.Context, rpc *rpcClient, t Terminal, x relayRequest, solUSD float64, gas map[string]float64) *Swap {
	dc := chainByID(0)
	for i := range originChains {
		if originChains[i].slug == x.DestChain {
			dc = &originChains[i]
		}
	}
	if dc == nil || x.InTx == "" || x.OutTx == "" {
		return nil
	}
	wei, ok := new(big.Int).SetString(x.OutValueWei, 10)
	if !ok || wei.Sign() <= 0 {
		return &Swap{Flag: "no_quote_received"}
	}
	price, quote := 1.0, "USDC"
	if dc.gas != "" {
		p, ok := gas[dc.gas]
		if !ok || p <= 0 {
			return &Swap{Flag: "gas_unknown"}
		}
		price, quote = p, strings.TrimSuffix(dc.gas, "-USD")
	} else if dc.slug != "arc" {
		return &Swap{Flag: "gas_unknown"} // a gas coin with no price pair (HyperEVM's HYPE): not a dollar
	}
	inTx, err := rpc.transaction(ctx, x.InTx)
	if err != nil || inTx == nil {
		return nil
	}
	givenUSD, feeUSD, _ := solanaGiven(inTx, x.User, solUSD)
	if givenUSD <= 0 {
		return &Swap{Flag: "no_deposit"}
	}
	recv := f(wei) / 1e18
	sw := &Swap{Method: methodVersion, Sig: x.OutTx, Terminal: t.Slug, Slot: inTx.Slot, User: x.Recipient, Side: "buy", Quote: quote, Venue: "relay", Mint: quote, Tokens: recv, QuoteUSD: price, Pools: 0,
		Chain: x.DestChain, RelayID: x.ID, InTx: x.InTx}
	if inTx.BlockTime != nil {
		sw.Time = *inTx.BlockTime
	}
	sw.UserQ = givenUSD / price
	sw.TerminalQ = x.AppFeeUsd / price
	sw.NetworkQ = (feeUSD + x.DestGasUsd) / price
	relay := givenUSD - feeUSD - recv*price - x.AppFeeUsd - x.DestGasUsd
	if relay < 0 {
		relay = 0
	}
	sw.RelayQ = relay / price
	sw.PoolQ = recv
	zero := 0.0
	sw.OtherQ = &zero
	one := 1.0
	sw.finalize(&one, 0, "reserves") // quote per quote: exact by construction
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
	sw.NetworkQ = (feeUSD + x.DestGasUsd) / q // origin gas, plus the destination gas Relay charged
	sw.PoolQ = s.PoolInUSD / q
	relay := givenUSD - feeUSD - x.AppFeeUsd - s.PoolInUSD - s.OtherUSD - x.DestGasUsd
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
// component below −10 %, a Relay component above 30 %, or a terminal fee
// above 10 % of the trade.
//
// The terminal bound is the one this cohort needed. On the EVM rows the
// terminal component is a residual, so every error on the quote side
// lands in it: Arc's native USDC, logged once as value and again as a
// mirror Transfer, produced a 5,047 bps "app fee" that no desk would
// believe and that dragged two pooled rows to 240. No app here charges
// more than a few percent.
func implausibleSplit(sw *Swap) {
	if sw.Priced && sw.TerminalBps > 1000 {
		sw.Flag, sw.Priced = "split_implausible", false
		return
	}
	// -200, not -1000: pool is the residual of the split, so below zero
	// the named costs add up to more than the trade lost. Measured on the
	// live sample, 141 of the 189 negative rows sit between -1 and 0 and
	// are rounding; 29 are worse than -50 and 19 of those are trades under
	// $10, where a fixed fee is a thousand basis points and the arithmetic
	// cannot stay consistent. -1000 let a -765 through.
	if sw.Priced && sw.PoolBps != nil && (*sw.PoolBps < -200 || sw.RelayBps > 3000 || (sw.Pools > 1 && *sw.PoolBps < -100)) {
		// A pool component under −100 bps on a route through several pools
		// is a quote leg the matching missed, not a fill better than the
		// mid (Binance's 7-pool route read terminal 1134 bps, pool −762).
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

var productNames = map[string]string{"fomo": "FOMO", "gmgn": "GMGN", "axiom": "Axiom", "banana-gun": "Banana Gun", "binance": "Binance", "basedbot": "BasedBot", "pump-fun": "pump.fun app", "phantom": "Phantom", "maestro": "Maestro", "bloom": "Bloom"}

// productAlias: the product a row belongs to when the bench names it
// differently from the row prefix (Binance Wallet's rows are the Binance
// product on the site, one page for the exchange's wallet and RPC).
var productAlias = map[string]string{"binance-wallet": "binance"}

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
	byProductFirm := map[string][]string{} // the rows above their own floor
	attOfRow := map[string]int{}           // each row's attempts in the window (its share of the product's flow)
	rowsOf := map[string][]Terminal{}
	var products []string
	for _, t := range cohort() {
		ts, ok := statsFor(st, t, []string{t.Slug}, minPriced, minRank)
		if !ok {
			continue
		}
		ts.Product, ts.Chain = productOf(t.Slug)
		if p, ok := productAlias[ts.Product]; ok {
			ts.Product = p
		}
		// A single chain's entry publishes from half the pooled threshold
		// (25 swaps): the chain tabs are an exploratory view of the pooled
		// figure, the interval next to the median says how firm it is.
		if minChain := max(20, minPriced/2); ts.Priced >= minChain {
			ts.Healthy = true
		}
		if t0, ok := st.Resampling[t.Slug]; ok && !ts.Healthy {
			ts.Note = strings.TrimSpace(ts.Note + " Re-sampling since " + time.Unix(t0, 0).UTC().Format("15:04 UTC") + " after a method change: the figure returns when the window refills.")
		}
		// A native EVM row whose sample is one side only with no fee on it
		// (Banana Gun's Ethereum buys) reads a fee-free half of the product:
		// the fee sits on the side the feed never sees, the row waits.
		if isNativeEVM(t.Slug) && ts.Parsed >= 20 && (ts.BuySharePct >= 99 || ts.BuySharePct <= 1) && ts.Components["terminal"] < 5 {
			ts.Healthy, ts.Ranked = false, false
			ts.Note = strings.TrimSpace(ts.Note + " One side only in the sample with no fee on it: the fee is taken on the side this feed never sees, so the row waits until both sides are read.")
		}
		out = append(out, ts)
		if ts.Chain == "funding" {
			continue
		}
		if byProduct[ts.Product] == nil {
			products = append(products, ts.Product)
		}
		byProduct[ts.Product] = append(byProduct[ts.Product], t.Slug)
		rowsOf[ts.Product] = append(rowsOf[ts.Product], t)
		attOfRow[t.Slug] = ts.Attempts
		if ts.Healthy {
			byProductFirm[ts.Product] = append(byProductFirm[ts.Product], t.Slug)
		}
	}
	for _, p := range products {
		// The pooled entry weighs each chain by its flow, so a chain row
		// under its own floor (a handful of swaps carrying most of the
		// product's attempts) would set the product's figure: only the rows
		// published on their own enter the pool; when none is, every row
		// does (the product is then published from the pooled count alone).
		rows := byProductFirm[p]
		waits := false
		if len(rows) == 0 {
			// No row is published on its own: the pooled entry is computed
			// over every row for the JSON but waits (a held row must never
			// carry the product: Banana Gun was published on 10 Solana swaps
			// weighted two thirds plus its fee-free Ethereum buys).
			rows, waits = byProduct[p], true
		}
		ts, ok := statsFor(st, productTerminal(p, rowsOf[p]), rows, minPriced, minRank)
		if !ok {
			continue
		}
		if waits {
			ts.Healthy, ts.Ranked = false, false
			re := false
			for _, s := range rows {
				if _, ok := st.Resampling[s]; ok {
					re = true
				}
			}
			if re {
				ts.Note = strings.TrimSpace(ts.Note + " Re-sampling after a method change: the figure returns when the window refills.")
			} else {
				ts.Note = strings.TrimSpace(ts.Note + " No chain row of this product is published on its own yet: the pooled figure waits.")
			}
		}
		if len(byProduct[p]) == 1 {
			// One chain only: the pooled entry is that row, published at the
			// row's own floor (25) so the main view agrees with the chain tab.
			for _, r := range out {
				if r.Slug == byProduct[p][0] {
					ts.Healthy = r.Healthy
					ts.Ranked = r.Healthy && ts.Priced >= minRank
				}
			}
		}
		ts.Product, ts.Chain = p, "all"
		if len(rows) < len(byProduct[p]) {
			// The rows left out carry part of the product's flow; when they
			// carry most of it the pooled figure would describe the minority
			// (Banana Gun's Ethereum buys, fee-free, ranked the product first
			// while its Solana row refilled): the entry waits for them.
			in, outAtt := 0, 0
			for _, s := range rows {
				in += attOfRow[s]
			}
			for _, s := range byProduct[p] {
				outAtt += attOfRow[s]
			}
			outAtt -= in
			if outAtt > in {
				ts.Healthy, ts.Ranked = false, false
				ts.Note = strings.TrimSpace(ts.Note + " The chain carrying most of this product's flow is still filling its window: the pooled figure waits for it.")
			} else {
				ts.Note = strings.TrimSpace(ts.Note + " Pooled over the chains published on their own; a chain still filling its window is left out until then.")
			}
		}
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
	rejects := map[string]int{} // the window's rejected draws by reason (from the minute buckets)
	{
		ts := TerminalStats{Slug: t.Slug, Name: t.Name, Kind: t.Kind, Note: t.Note, Components: map[string]float64{}, Venues: map[string]float64{}, Quotes: map[string]float64{}, Rejects: rejects}
		errs := map[string]int{}
		pooled := len(slugs) > 1
		// Fail-rate base: the feed's attempts, or the block sample's on a
		// native EVM row. In a pooled entry the sample's counts are scaled
		// by its coverage (blocks read over blocks in range), so a chain
		// read at 5 % weighs like one read in full.
		att, failed := 0.0, 0.0
		attOf := map[string]float64{} // each row's attempts in the window (estimated on native rows)
		for _, slug := range slugs {
			native := isNativeEVM(slug)
			var seen, sfailed, ss, sf, sb, sp int
			for _, b := range st.Buckets[slug] {
				seen += b.Seen
				sfailed += b.Failed
				ts.NonSwap += b.Other
				ss += b.SampSeen
				sf += b.SampFailed
				sb += b.SampBlocks
				sp += b.SpanBlocks
				for k, v := range b.Errs {
					errs[k] += v
				}
				for k, v := range b.Rej {
					rejects[k] += v
				}
			}
			ts.Seen += seen
			ts.Failed += sfailed
			ts.SampSeen += ss
			ts.SampFailed += sf
			if native {
				cov := 1.0
				if sb > 0 && sp > 0 {
					cov = float64(sb) / float64(sp) // the block sample's coverage: attempts are estimated from it on every entry
				}
				// The block sample only counts transactions sent to the router;
				// swaps sent through a smart account or a relayer emit the
				// router's event without naming it as `to` (a quarter of the
				// flow on Robinhood Chain), so the attempts are never below
				// the successes the log feed saw plus the failures estimated.
				est := math.Max(float64(ss)/cov, float64(seen)+float64(sf)/cov)
				att += est
				failed += float64(sf) / cov
				attOf[slug] = est
			} else {
				att += float64(seen)
				failed += float64(sfailed)
				attOf[slug] = float64(seen)
			}
		}
		ts.Attempts, ts.AttemptsFailed = int(math.Round(att)), int(math.Round(failed))
		if len(rejects) == 0 {
			ts.Rejects = nil
		}
		if att >= 20 && (ts.SampSeen == 0 || ts.SampSeen >= 20) {
			fr := 100 * failed / att
			ts.FailRate = &fr // percent (a native row: from 20 sampled transactions, not 20 scaled ones)
		}
		// A pooled entry weighs each row's sampled swaps by the row's
		// attempts per sample: the chains are sampled at a fixed daily
		// rate each, not in proportion to their flow, and a median over the
		// plain concatenation would describe the sampler, not the users.
		weightOf := map[string]float64{}
		if pooled {
			nrows := map[string]int{}
			for _, s := range st.Swaps {
				if member[s.Terminal] && s.Method == methodVersion {
					nrows[s.Terminal]++
				}
			}
			for _, slug := range slugs {
				if nrows[slug] > 0 && attOf[slug] > 0 {
					weightOf[slug] = attOf[slug] / float64(nrows[slug])
				}
			}
		}
		// Farming loops on a row that drops them: a wallet trading the same
		// token both ways four times or more in the window.
		loopers := loopersOf(st, slugs)
		wOf := func(s Swap) float64 {
			if w := weightOf[s.Terminal]; w > 0 {
				return w
			}
			return 1
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
		// Loss with the app's own fee taken out, subtracted on each swap
		// before any median is taken: median(loss) - median(fee) is a
		// different number, off by 33 bps on the row the subtraction
		// moves most.
		var exFee, exFeeW []float64
		var lossW, poolW, termW, netW, relayW, otherW, tradeW []float64 // the rows' weights, same order
		bySize := map[string][]float64{}
		// The same swaps again, grouped by trade size, so a reader can ask
		// what a $10 swap costs on this terminal rather than what its
		// median swap costs. Unweighted on purpose, see sizeSplit.
		sz := map[string]*sizeAcc{}
		accOf := func(usd float64) *sizeAcc {
			b := sizeBucket(usd)
			if sz[b] == nil {
				sz[b] = &sizeAcc{}
			}
			return sz[b]
		}
		byChain := map[string][]float64{}
		refSrc := map[string]int{}
		buys := 0
		refPool := 0
		venues := map[string]int{}
		quotes := map[string]int{}
		otherAgg := map[string]*OtherRecipient{}
		looped := 0
		for _, s := range st.Swaps {
			if !member[s.Terminal] || s.Method != methodVersion {
				continue
			}
			if loopers[s.Terminal+":"+s.User] {
				looped++
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
			w := wOf(s)
			if s.TradeUSD > 0 {
				a := accOf(s.TradeUSD)
				a.parsed++
				a.term = append(a.term, s.TerminalBps)
				a.termW = append(a.termW, w)
				a.net = append(a.net, s.NetworkBps)
				a.netW = append(a.netW, w)
				a.trade = append(a.trade, s.TradeUSD)
				a.tradeW = append(a.tradeW, w)
				if s.RelayID != "" {
					a.relay = append(a.relay, s.RelayBps)
					a.relayW = append(a.relayW, w)
				}
				if s.OtherBps != nil {
					a.other = append(a.other, *s.OtherBps)
					a.otherW = append(a.otherW, w)
				}
				if s.Priced && s.LossBps != nil {
					a.loss = append(a.loss, *s.LossBps)
					a.lossW = append(a.lossW, w)
					if s.PoolBps != nil && !s.RelayUnknown {
						// Pool is the residual, so an unknown relay cut sits
						// inside it. Leaving the row in would charge the pool
						// for the bridge.
						a.pool = append(a.pool, *s.PoolBps)
						a.poolW = append(a.poolW, w)
					}
				}
			}
			// The component medians take the same rows as the loss. They
			// used to run over every parsed swap, so a row the bounds threw
			// out still voted on the fee column: 51 of gmgn-arc's 85 swaps
			// were flagged, and the fee they held (5,047 bps) stood beside a
			// loss computed without them.
			//
			// This guards the appends and not the iteration: the counters
			// below (buy share, venue and quote mix, flagged, and ts.Priced
			// itself) must still see every parsed swap.
			if s.Priced && s.LossBps != nil {
				term = append(term, s.TerminalBps)
				termW = append(termW, w)
				net = append(net, s.NetworkBps)
				netW = append(netW, w)
				// A Relay row whose cut came back empty from the API is an
				// unknown, not a zero: averaging it in would pull the
				// column toward a number nobody was charged.
				if s.RelayID != "" && !s.RelayUnknown {
					relay = append(relay, s.RelayBps)
					relayW = append(relayW, w)
				}
				if s.OtherBps != nil {
					other = append(other, *s.OtherBps)
					otherW = append(otherW, w)
				}
			}
			if s.TradeUSD > 0 {
				trade = append(trade, s.TradeUSD)
				tradeW = append(tradeW, w)
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
				lossW = append(lossW, w)
				// Negative is a real outcome here (a rebate, or a reference
				// that drifted the user's way) and stays: clipping at zero
				// would push the median up.
				exFee = append(exFee, *s.LossBps-s.TerminalBps)
				exFeeW = append(exFeeW, w)
				bySize[sizeBucket(s.TradeUSD)] = append(bySize[sizeBucket(s.TradeUSD)], *s.LossBps)
				if s.Chain != "" {
					byChain[s.Chain] = append(byChain[s.Chain], *s.LossBps)
				} else if len(slugs) > 1 {
					byChain["solana"] = append(byChain["solana"], *s.LossBps) // a product pooled over its chains
				}
				if s.PoolBps != nil {
					pool = append(pool, *s.PoolBps)
					poolW = append(poolW, w)
				}
			}
		}
		if looped > 0 {
			ts.LoopShare = float64(looped) / float64(looped+ts.Parsed)
		}
		if ts.Parsed > 0 {
			// A pooled entry's split: each chain's median weighted by the
			// chain's flow (a weighted median over a bimodal mix, pump.fun's
			// fee on the Solana swaps and none on the EVM ones, would land on
			// one chain's mode and print a 0 that describes no user).
			ts.Components["terminal"] = wmedian(term, termW, pooled)
			ts.Components["network"] = wmedian(net, netW, pooled)
			if len(other) > 0 {
				ts.Components["other"] = wmedian(other, otherW, pooled)
			}
			if len(relay) > 0 {
				ts.Components["relay"] = wmedian(relay, relayW, pooled)
			}
			if pooled {
				cm := chainMeanOfMedians(st, member, slugs, attOf, c2field, nil)
				for c, v := range cm {
					ts.Components[c] = v
				}
				for _, c := range []string{"relay", "other"} {
					if _, ok := cm[c]; !ok {
						delete(ts.Components, c) // carried by under half the product's flow: blank, not a minority's median
					}
				}
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
			ts.TradeUSD = wquantiles(trade, tradeW, false, pooled)
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
			ts.Loss = wquantiles(loss, lossW, true, pooled)
			ts.LossExFee = wquantiles(exFee, exFeeW, true, pooled)
			if pooled {
				// Kish's effective sample size: (Σw)² / Σw². Ten swaps
				// weighted two thirds of a pool read as a sample of 22.
				sw, sw2 := 0.0, 0.0
				for _, w := range lossW {
					sw += w
					sw2 += w * w
				}
				if sw2 > 0 {
					ts.NEff = sw * sw / sw2
				}
			}
			if len(pool) > 0 {
				ts.Components["pool"] = wmedian(pool, poolW, pooled)
				if pooled {
					if v, ok := chainMeanOfMedians(st, member, slugs, attOf, c2field, nil)["pool"]; ok {
						ts.Components["pool"] = v
					}
				}
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
			ts.SizeSplit = sizeSplit(sz, minPricedSize, minRankSize, pooled)
			if pooled {
				// Same rule as the pooled row, narrowed to each bucket, so
				// the buckets decompose the published figure instead of
				// answering a different question.
				for b, st2 := range ts.SizeSplit {
					bucket := b
					cmB := chainMeanOfMedians(st, member, slugs, attOf, c2field, func(s Swap) bool {
						return s.TradeUSD > 0 && sizeBucket(s.TradeUSD) == bucket
					})
					for _, c := range []string{"terminal", "network", "pool"} {
						if v, ok := cmB[c]; ok {
							st2.Components[c] = v
						} else {
							delete(st2.Components, c)
						}
					}
					for _, c := range []string{"relay", "other"} {
						if v, ok := cmB[c]; ok {
							st2.Components[c] = v
						} else {
							delete(st2.Components, c) // under half the bucket's flow: blank, like the pooled row
						}
					}
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
		// The share of the window's drawn swaps that could not be valued:
		// large on the EVM rows, where routes through pools without a quote
		// leg or undecoded venues stay out.
		if total := 0; rejects != nil {
			unpriced := 0
			for k, v := range rejects {
				total += v
				if strings.HasPrefix(k, "unpriced") || k == "no_pool" || k == "no_quote_leg" {
					unpriced += v
				}
			}
			if ts.Parsed+total > 0 && unpriced > 0 {
				ts.UnpricedShare = float64(unpriced) / float64(ts.Parsed+total)
			}
		}
		ts.Healthy = ts.Priced >= minPriced
		if pooled && ts.NEff > 0 && ts.NEff < float64(max(20, minPriced/2)) {
			ts.Healthy = false // the pooled median rests on too few effective swaps
		}
		ts.Ranked = ts.Priced >= minRank
		if pooled && ts.NEff > 0 && ts.NEff < float64(minRank) {
			ts.Ranked = false // one chain's few swaps carry most of the weight: the median is not stable enough to rank
		}
		if len(slugs) == 1 && strings.Contains(t.Slug, "-") && isXchainRow(t.Slug) && ts.Seen == 0 && ts.Parsed == 0 {
			// Nobody used it, or we could not read the chain. Those are not
			// the same thing, and dropping both is how six products
			// published All chains rows with no BNB in them for days, under
			// tags that name BNB, while the log feed sat 630,000 blocks
			// behind. A row on a dead chain stays, unhealthy and saying so.
			if since, dead := st.FeedDown[ts.Chain]; dead {
				ts.Healthy, ts.Ranked = false, false
				mins := (time.Now().Unix() - since) / 60
				ts.Note = "no data: this chain's log feed has not read for " + strconv.FormatInt(mins, 10) + " minutes, so the row is empty because we could not look, not because nobody traded"
				return ts, true
			}
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
		if !ts.Healthy {
			// An entry under its floor publishes its sample sizes and its
			// health only: a split or a trade size next to an unpublished
			// headline would read as a figure.
			for _, g := range []*prometheus.GaugeVec{gLoss, gComponent, gTrade, gVenue, gLossSize, gLossChain} {
				g.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
			}
			for _, g := range []*prometheus.GaugeVec{gFail, gBuy, gSandwich, gSandwichProfit, gFailCost, gFailOverhead, gUnpriced} {
				g.DeleteLabelValues(ts.Product, ts.Chain)
			}
			for g := range map[*prometheus.GaugeVec]bool{gSamples: true, gHealth: true, gRanked: true, gLostUSD: true} {
				g.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
			}
			gSamples.WithLabelValues(ts.Product, ts.Chain, "seen", "all").Set(float64(ts.Seen))
			gSamples.WithLabelValues(ts.Product, ts.Chain, "parsed", "all").Set(float64(ts.Parsed))
			gSamples.WithLabelValues(ts.Product, ts.Chain, "priced", "all").Set(float64(ts.Priced))
			if ts.NEff > 0 {
				gSamples.WithLabelValues(ts.Product, ts.Chain, "effective", "all").Set(math.Round(ts.NEff))
			}
			gHealth.WithLabelValues(ts.Product, ts.Chain, "all").Set(0)
			gRanked.WithLabelValues(ts.Product, ts.Chain, "all").Set(0)
			continue
		}
		if ts.Loss != nil && ts.Healthy {
			gLoss.WithLabelValues(ts.Product, ts.Chain, "median", "all").Set(ts.Loss.Median)
			gLoss.WithLabelValues(ts.Product, ts.Chain, "p90", "all").Set(ts.Loss.P90)
			gLoss.WithLabelValues(ts.Product, ts.Chain, "p99", "all").Set(ts.Loss.P99)
			if ts.Loss.CILo != nil && ts.Loss.CIHi != nil {
				gLoss.WithLabelValues(ts.Product, ts.Chain, "ci_lo", "all").Set(*ts.Loss.CILo)
				gLoss.WithLabelValues(ts.Product, ts.Chain, "ci_hi", "all").Set(*ts.Loss.CIHi)
			}
		} else {
			gLoss.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
		}
		// Execution quality: published under exactly the same conditions as
		// the headline, so the two benches never disagree about who is
		// present. A row that is not healthy here is not healthy there.
		if ts.LossExFee != nil && ts.Healthy {
			gLossExFee.WithLabelValues(ts.Product, ts.Chain, "median", "all").Set(ts.LossExFee.Median)
			gLossExFee.WithLabelValues(ts.Product, ts.Chain, "p90", "all").Set(ts.LossExFee.P90)
			gLossExFee.WithLabelValues(ts.Product, ts.Chain, "p99", "all").Set(ts.LossExFee.P99)
			if ts.LossExFee.CILo != nil && ts.LossExFee.CIHi != nil {
				gLossExFee.WithLabelValues(ts.Product, ts.Chain, "ci_lo", "all").Set(*ts.LossExFee.CILo)
				gLossExFee.WithLabelValues(ts.Product, ts.Chain, "ci_hi", "all").Set(*ts.LossExFee.CIHi)
			}
		} else {
			gLossExFee.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
		}
		gComponent.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain}) // a component that dropped out stays out
		for c, v := range ts.Components {
			gComponent.WithLabelValues(ts.Product, ts.Chain, c, "all").Set(v)
		}
		if ts.FailRate != nil {
			gFail.WithLabelValues(ts.Product, ts.Chain).Set(*ts.FailRate) // already percent
		} else {
			gFail.DeleteLabelValues(ts.Product, ts.Chain)
		}
		gSamples.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
		gSamples.WithLabelValues(ts.Product, ts.Chain, "seen", "all").Set(float64(ts.Seen))
		gSamples.WithLabelValues(ts.Product, ts.Chain, "parsed", "all").Set(float64(ts.Parsed))
		gSamples.WithLabelValues(ts.Product, ts.Chain, "priced", "all").Set(float64(ts.Priced))
		if ts.NEff > 0 {
			gSamples.WithLabelValues(ts.Product, ts.Chain, "effective", "all").Set(math.Round(ts.NEff))
		}
		if ts.TradeUSD != nil {
			gTrade.WithLabelValues(ts.Product, ts.Chain, "median", "all").Set(ts.TradeUSD.Median)
			gTrade.WithLabelValues(ts.Product, ts.Chain, "p90", "all").Set(ts.TradeUSD.P90)
			gTrade.WithLabelValues(ts.Product, ts.Chain, "p99", "all").Set(ts.TradeUSD.P99)
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
		if ts.Loss != nil && ts.Healthy && ts.TradeUSD != nil {
			gLostUSD.WithLabelValues(ts.Product, ts.Chain, "all").Set(ts.TradeUSD.Median * ts.Loss.Median / 1e4)
		} else {
			gLostUSD.DeletePartialMatch(prometheus.Labels{"terminal": ts.Product, "chain": ts.Chain})
		}
		if ts.UnpricedShare > 0 {
			gUnpriced.WithLabelValues(ts.Product, ts.Chain).Set(ts.UnpricedShare)
		} else {
			gUnpriced.DeleteLabelValues(ts.Product, ts.Chain)
		}
		gHealth.WithLabelValues(ts.Product, ts.Chain, "all").Set(b2f(ts.Healthy))
		gRanked.WithLabelValues(ts.Product, ts.Chain, "all").Set(b2f(ts.Ranked))
		publishSizeGauges(ts)
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

// recent returns the evidence behind the board: the last `perTerminal`
// swaps of EACH row, not the last N swaps overall.
//
// The global tail it replaces spanned 114 minutes against a 24h window,
// so 89% of ranked rows had fewer than 20 transactions to show and six
// had none, while the table invited the reader to check the board
// against it. Sampling per row costs about twice the payload and makes
// every published figure auditable.
//
// Each swap also carries the product it rolls up to, so a pooled row
// (Binance, whose swaps are stored under binance-wallet-*) can match its
// own transactions. `total` is a ceiling for the payload, spent on the
// rows with the least evidence first so a busy terminal cannot squeeze
// out a quiet one.
// flowOf: attempts per row, from the stats just computed. This is the
// weight the pooled median uses, so it is the weight the evidence under
// it has to use too.
func flowOf(stats []TerminalStats) map[string]float64 {
	out := make(map[string]float64, len(stats))
	for _, t := range stats {
		if t.Chain == "all" {
			continue // the pooled entry is the sum of the rows below it
		}
		if t.Attempts > 0 {
			out[t.Slug] = float64(t.Attempts)
		}
	}
	return out
}

// spread picks n rows evenly across the whole list rather than taking
// the head of it.
//
// byTerm is newest-first, so taking the head gave a row the last n swaps
// — a slice of the past hour standing in for a 24h median. On a row with
// fifteen rows that is survivable; on one cut to its floor it is not, and
// pump-fun-ethereum read 1719 against a published 646 with one row of
// nine below the median. Even spacing makes the rows shown cover the
// window the figure covers.
func spread(rows []Swap, n int) []Swap {
	if n >= len(rows) {
		return rows
	}
	if n <= 0 {
		return nil
	}
	out := make([]Swap, 0, n)
	// Sample at the midpoint of each of n equal buckets, so the first and
	// last rows are not systematically favoured.
	for i := 0; i < n; i++ {
		idx := (2*i + 1) * len(rows) / (2 * n)
		if idx >= len(rows) {
			idx = len(rows) - 1
		}
		out = append(out, rows[idx])
	}
	return out
}

// PublicSwap is the audit table's row: what src/lib/terminal-fills.ts
// actually reads, and nothing else.
//
// Swap carries about forty fields because the state file needs them to
// recompute. Publishing all forty cost 1,150 bytes a row against a 2 MB
// ceiling, which capped the sample at 1,250 rows — and that cap is what
// made the floor for small chains and the flow weighting for pooled rows
// compete: every row given to a quiet chain came off the chain carrying
// 95% of the flow. Half those bytes were fields nothing renders.
//
// Add a field here when the table starts reading it, not before.
type PublicSwap struct {
	Sig      string  `json:"sig"`
	Terminal string  `json:"terminal"`
	Product  string  `json:"product,omitempty"`
	Time     int64   `json:"time"`
	Side     string  `json:"side"`
	Quote    string  `json:"quote"`
	Venue    string  `json:"venue"`
	Chain    string  `json:"chain,omitempty"`
	Hops     int     `json:"hops,omitempty"`
	XMint    string  `json:"x_mint,omitempty"`
	InTx     string  `json:"in_tx,omitempty"`
	RentQ    float64 `json:"rent_q,omitempty"`
	QuoteUSD float64 `json:"quote_usd"`
	TradeUSD float64 `json:"trade_usd"`
	Priced   bool    `json:"priced"`
	Scanned  bool    `json:"scanned"`
	Flag     string  `json:"flag,omitempty"`
	RefSrc   string  `json:"ref_src,omitempty"`
	RefAgeS  *int64  `json:"ref_age_s,omitempty"`

	LossBps     *float64 `json:"loss_bps,omitempty"`
	PoolBps     *float64 `json:"pool_bps,omitempty"`
	TerminalBps float64  `json:"terminal_bps"`
	NetworkBps  float64  `json:"network_bps"`
	RelayBps    float64  `json:"relay_bps,omitempty"`
	// True when the Relay request carried no fee at all: the cut is
	// unknown rather than nil, and pool_bps on this row absorbs it.
	RelayUnknown bool     `json:"relay_unknown,omitempty"`
	OtherBps    *float64 `json:"other_bps,omitempty"`

	Sandwich *Sandwich `json:"sandwich,omitempty"`

	// What this row stands for, in attempts. A terminal's rows carry its
	// flow divided between them, so summing the weights of the rows shown
	// for a terminal gives back its flow.
	//
	// The board's pooled median weights each chain by flow; the table
	// used to take a plain median of the rows it happened to have, and
	// the two disagreed by 25% on pump.fun. They cannot be reconciled by
	// sampling: Solana is 95% of that product's flow and we have priced
	// 124 of its 664,575 attempts, all of which are already shown. So the
	// weight travels with the row and the table computes the same
	// statistic the headline does.
	W float64 `json:"w,omitempty"`
}

func publicSwaps(in []Swap, flow map[string]float64) []PublicSwap {
	// Rows shown per terminal, so each row can carry its share of that
	// terminal's flow rather than counting as one observation.
	shown := map[string]int{}
	for _, s := range in {
		shown[s.Terminal]++
	}
	out := make([]PublicSwap, 0, len(in))
	for _, s := range in {
		w := 1.0
		if f := flow[s.Terminal]; f > 0 && shown[s.Terminal] > 0 {
			w = f / float64(shown[s.Terminal])
		}
		out = append(out, PublicSwap{
			Sig: s.Sig, Terminal: s.Terminal, Product: s.Product, Time: s.Time,
			Side: s.Side, Quote: s.Quote, Venue: s.Venue, Chain: s.Chain,
			Hops: s.Hops, XMint: s.XMint, InTx: s.InTx, RentQ: s.RentQ,
			QuoteUSD: s.QuoteUSD, TradeUSD: s.TradeUSD,
			Priced: s.Priced, Scanned: s.Scanned, Flag: s.Flag,
			RefSrc: s.RefSrc, RefAgeS: s.RefAgeS,
			LossBps: s.LossBps, PoolBps: s.PoolBps,
			TerminalBps: s.TerminalBps, NetworkBps: s.NetworkBps,
			RelayBps: s.RelayBps, RelayUnknown: s.RelayUnknown, OtherBps: s.OtherBps,
			Sandwich: s.Sandwich, W: w,
		})
	}
	return out
}

func recent(st *State, minPerTerminal, total int, flow map[string]float64) []Swap {
	// Every swap each row has in the window, newest first. The caps are
	// applied after the shares are known, not while collecting, because
	// a row's share depends on how much flow it has relative to the rest.
	byTerm := map[string][]Swap{}
	for i := len(st.Swaps) - 1; i >= 0; i-- {
		s := st.Swaps[i]
		byTerm[s.Terminal] = append(byTerm[s.Terminal], s)
	}
	slugs := make([]string, 0, len(byTerm))
	grand := 0
	for k, v := range byTerm {
		slugs = append(slugs, k)
		grand += len(v)
	}
	sort.Strings(slugs)
	if grand == 0 {
		return nil
	}

	// Proportional to flow, between a floor and a cap.
	//
	// Equal shares per row was the bug: a pooled product row shows the
	// union of its members, its median weights those members by flow, and
	// with 15 apiece the union looked nothing like the median — Solana
	// carried 55% of pump.fun's flow and 12% of its table.
	//
	// The floor keeps a quiet row auditable, which is the whole reason
	// per-row sampling replaced the global tail; the cap stops one busy
	// row eating the budget. Between them the share is proportional, so a
	// pooled row's sample resembles its own statistic.
	// Two parts, because the floor and the proportion answer different
	// questions and must not be traded against each other.
	//
	// First the floor: every row keeps enough rows to be auditable, or
	// everything it has if that is less. This is the coverage guarantee
	// and it is not negotiable — it is why per-row sampling replaced the
	// global tail.
	quota := make(map[string]int, len(slugs))
	base := 0
	for _, slug := range slugs {
		q := minPerTerminal
		if n := len(byTerm[slug]); q > n {
			q = n
		}
		quota[slug] = q
		base += q
	}

	// Then the remainder, split in proportion to the flow each row has
	// above its floor.
	//
	// There is deliberately no per-row ceiling. One existed, to stop a
	// busy row spending the whole budget, and it quietly undid the
	// proportion: whenever it bound on the dominant row, that row's share
	// collapsed toward everyone else's and the pooled sample was
	// equal-weighted again, which is the bug this function exists to fix.
	// A dominant row taking a large share is the correct answer — it
	// really is most of the flow, and the pooled median really does
	// follow it. Coverage is the floor's job, and the total is the
	// payload guard.
	room := total - base
	if room > 0 {
		// Share of the remainder follows each row's FLOW, not how many of
		// its swaps we managed to price. Those differ by a factor of sixty
		// between chains — 0.02% of Solana attempts get priced against
		// 1.2% of BNB's — and the pooled median weights by the first, so
		// a sample drawn on the second cannot reproduce it however evenly
		// it is spread. A row with no flow figure falls back to its swap
		// count, which is the best proxy available.
		weight := make(map[string]float64, len(slugs))
		spare := make(map[string]int, len(slugs))
		spareTotal := 0.0
		for _, slug := range slugs {
			headroom := len(byTerm[slug]) - quota[slug]
			if headroom < 0 {
				headroom = 0
			}
			spare[slug] = headroom
			if headroom == 0 {
				continue // nothing left to give this row
			}
			w := flow[slug]
			if w <= 0 {
				w = float64(len(byTerm[slug]))
			}
			weight[slug] = w
			spareTotal += w
		}
		if spareTotal > 0 {
			// Integer division loses seats; largest remainder hands them
			// back, so the budget is spent instead of left over. A quota
			// bigger than the swaps a row actually has is clipped here,
			// and what that frees is handed out in the same pass.
			type rem struct {
				slug string
				frac float64
			}
			rems := make([]rem, 0, len(slugs))
			given := 0
			for _, slug := range slugs {
				exact := float64(room) * weight[slug] / spareTotal
				q := int(exact)
				if q > spare[slug] {
					q = spare[slug]
				}
				quota[slug] += q
				given += q
				rems = append(rems, rem{slug, exact - float64(q)})
			}
			sort.Slice(rems, func(i, j int) bool {
				if rems[i].frac != rems[j].frac {
					return rems[i].frac > rems[j].frac
				}
				return rems[i].slug < rems[j].slug
			})
			// Several passes, because clipping a row to what it has frees
			// seats that the rows still short of their share should get.
			//
			// No pass limit: each pass hands out at most one seat per row,
			// so a fixed count silently caps how much can be redistributed.
			// Three passes over 68 legs could return 204 seats where the
			// clipping had freed 779, and the budget went unspent — 1621
			// rows shipped against a configured 2400, with 39 of 68 legs
			// left sitting on the floor. `moved` is the real termination
			// condition: it goes false the moment no row can take another
			// seat, which is also the only way this loop can end.
			for given < room {
				moved := false
				for i := 0; given < room && i < len(rems); i++ {
					slug := rems[i].slug
					if quota[slug] < len(byTerm[slug]) {
						quota[slug]++
						given++
						moved = true
					}
				}
				if !moved {
					break
				}
			}
		}
	}

	out := make([]Swap, 0, total)
	for _, slug := range slugs {
		rows := spread(byTerm[slug], quota[slug])
		for _, s := range rows {
			p, chain := productOf(s.Terminal)
			if a, ok := productAlias[p]; ok {
				p = a
			}
			// A funding leg is a bridge, not a fill, and compute() leaves
			// it out of the product's pooled entry. Stamping it would put
			// rows in the pooled table that the pooled figure excludes:
			// pump.fun's members summed to 483 against a pooled 448, and
			// the 35 in between were exactly this. It keeps its own row in
			// the dropdown, where its figure is published.
			if p != s.Terminal && chain != "funding" {
				s.Product = p
			}
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Time < out[j].Time })
	return out
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
	q := &Quantiles{Median: pct(s, 0.5), P90: pct(s, 0.9), P99: pct(s, 0.99), N: len(s)}
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

// c2field reads one component of a swap, in basis points (ok false when
// the swap has none).
func c2field(s Swap, c string) (float64, bool) {
	switch c {
	case "terminal":
		return s.TerminalBps, true
	case "network":
		return s.NetworkBps, true
	case "relay":
		if s.RelayID == "" {
			return 0, false
		}
		return s.RelayBps, true
	case "other":
		if s.OtherBps == nil {
			return 0, false
		}
		return *s.OtherBps, true
	case "pool":
		if !s.Priced || s.PoolBps == nil {
			return 0, false
		}
		return *s.PoolBps, true
	}
	return 0, false
}

// chainMeanOfMedians: for a pooled entry, each component as the mean of
// the rows' medians weighted by the rows' attempts, over the rows that
// carry the component (a Solana row whose swaps are all routed has no
// "other": pump.fun's fees sit inside its pool figure); published only
// when those rows carry at least half of the product's flow, else the
// column stays blank rather than describing a minority.
//
// `keep` narrows it to a subset of the window (a trade-size bucket) while
// keeping the estimator identical: each row's weight is scaled by the share
// of its swaps that the subset holds, so the row counts for the flow it
// actually contributes there. nil keeps everything, which is the pooled row
// and leaves the weight exactly attOf[slug].
func chainMeanOfMedians(st *State, member map[string]bool, slugs []string, attOf map[string]float64, get func(Swap, string) (float64, bool), keep func(Swap) bool) map[string]float64 {
	out := map[string]float64{}
	for _, c := range []string{"terminal", "network", "relay", "other", "pool"} {
		num, den, denAll := 0.0, 0.0, 0.0
		any := false
		for _, slug := range slugs {
			var vals []float64
			rows, rowsAll := 0, 0
			for _, s := range st.Swaps {
				if s.Terminal != slug || s.Method != methodVersion {
					continue
				}
				rowsAll++
				if keep != nil && !keep(s) {
					continue
				}
				rows++
				if v, ok := get(s, c); ok {
					vals = append(vals, v)
				}
			}
			if rows == 0 {
				continue
			}
			w := attOf[slug]
			if w <= 0 {
				w = float64(rows)
			} else if rows < rowsAll {
				w *= float64(rows) / float64(rowsAll)
			}
			denAll += w
			if len(vals) == 0 {
				continue
			}
			any = true
			num += w * median(vals)
			den += w
		}
		if any && den > 0 && den >= 0.5*denAll {
			out[c] = num / den
		}
	}
	return out
}

// wpct: the weighted quantile (the value where the cumulative weight,
// values sorted, first reaches the share p of the total).
func wpct(v, w []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	idx := make([]int, len(v))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool { return v[idx[a]] < v[idx[b]] })
	total := 0.0
	for _, x := range w {
		total += x
	}
	if total <= 0 {
		s := append([]float64(nil), v...)
		sort.Float64s(s)
		return pct(s, p)
	}
	acc := 0.0
	for _, i := range idx {
		acc += w[i]
		if acc >= p*total {
			return v[i]
		}
	}
	return v[idx[len(idx)-1]]
}

// wmedian: the plain median, or the weighted one on a pooled entry.
func wmedian(v, w []float64, weighted bool) float64 {
	if !weighted {
		return median(v)
	}
	return wpct(v, w, 0.5)
}

// wquantiles: quantiles, weighted on a pooled entry; the interval by a
// bootstrap drawing rows in proportion to their weight.
func wquantiles(v, w []float64, ci, weighted bool) *Quantiles {
	if !weighted {
		return quantiles(v, ci)
	}
	if len(v) == 0 {
		return nil
	}
	q := &Quantiles{Median: wpct(v, w, 0.5), P90: wpct(v, w, 0.9), P99: wpct(v, w, 0.99), N: len(v)}
	if ci && len(v) >= 5 {
		cum := make([]float64, len(v))
		acc := 0.0
		for i := range v {
			acc += w[i]
			cum[i] = acc
		}
		if acc <= 0 {
			return quantiles(v, ci)
		}
		const rounds = 300
		meds := make([]float64, rounds)
		tmp := make([]float64, len(v))
		for r := range meds {
			for i := range tmp {
				j := sort.SearchFloat64s(cum, rand.Float64()*acc)
				if j >= len(v) {
					j = len(v) - 1
				}
				tmp[i] = v[j]
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
	// PURGE_TERMINALS (comma-separated slugs) drops those rows once, after
	// a feed change that made the row's sample unrepresentative.
	purgeSlugs := set(strings.Split(os.Getenv("PURGE_TERMINALS"), ",")...)
	// A method change that moved only the arithmetic — not the reference,
	// not what was read from the chain — applies to the stored window in
	// place, because every input finalize needs is already on the row.
	// Methods 4 and 5 rebased the loss on the Solana rows whose gas was
	// paid outside the quote: recomputing and restamping them carries the
	// correction to the whole window at once, where dropping them would
	// have emptied the board until the window refilled. A change that
	// alters what is read, or the reference it is read against, still
	// needs the drop below.
	//
	// One caveat this cannot repair: v5 needs to know how much of the gas
	// the user paid themselves, and rows written earlier never recorded
	// it. Replayed, they read as fully sponsored — correct for the great
	// majority, since 73 of the 76 rows in that cell were, and wrong by
	// the user's own gas on the rest until the window turns over.
	refinal := 0
	if methodVersion == 5 {
		for i := range st.Swaps {
			s := &st.Swaps[i]
			if s.Method != 3 && s.Method != 4 {
				continue
			}
			age := int64(0)
			if s.RefAgeS != nil {
				age = *s.RefAgeS
			}
			s.finalize(s.RefPrice, age, s.RefSrc) // nil reference: the row stays unpriced, as it was
			// finalize clears Flag and sets Priced again on its first
			// lines, so a replay silently un-drops a row the guard had
			// dropped. Re-apply it.
			implausibleSplit(s)
			s.Method = methodVersion
			refinal++
		}
	}
	kept := st.Swaps[:0]
	dropped, purged := 0, 0
	if st.Resampling == nil {
		st.Resampling = map[string]int64{}
	}
	now := time.Now().Unix()
	for _, s := range st.Swaps {
		if s.Method != methodVersion {
			dropped++
			continue
		}
		if (purgeBefore > 0 && s.Chain != "" && s.Time < purgeBefore) || purgeSlugs[s.Terminal] {
			purged++
			st.Resampling[s.Terminal] = now
			continue
		}
		kept = append(kept, s)
	}
	for slug, t := range st.Resampling {
		if now-t > 24*3600 {
			delete(st.Resampling, slug)
		}
	}
	st.Swaps = kept
	log.Printf("[state] loaded %d swaps from %s (%d recomputed into method v%d, %d of another method version dropped, %d rows purged: PURGE_EVM_BEFORE=%d PURGE_TERMINALS=%q; a purge variable stays in the container's env until the next deploy resets it)", len(st.Swaps), path, refinal, methodVersion, dropped, purged, purgeBefore, os.Getenv("PURGE_TERMINALS"))
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

// loopersOf: "<slug>:<wallet>" for the wallets farming loops on the rows
// that drop them (the same token both ways, four swaps or more in the
// window); shared by the statistics and the block sample's attempts.
func loopersOf(st *State, slugs []string) map[string]bool {
	loopers := map[string]bool{}
	for _, slug := range slugs {
		if !dropsLoops(slug) {
			continue
		}
		type um struct{ u, m string }
		sides := map[um][2]int{}
		count := map[string]int{}
		for _, s := range st.Swaps {
			if s.Terminal != slug || s.Method != methodVersion {
				continue
			}
			k := um{s.User, s.Mint}
			v := sides[k]
			if s.Side == "buy" {
				v[0]++
			} else {
				v[1]++
			}
			sides[k] = v
			count[s.User]++
		}
		for k, v := range sides {
			if v[0] > 0 && v[1] > 0 && count[k.u] >= 4 {
				loopers[slug+":"+k.u] = true
			}
		}
	}
	return loopers
}

// feeTxSwap: a terminal whose fee is a separate transaction (BasedBot on
// Solana). feeTx is the sampled fee transaction; the swap is the payer's
// previous transaction. The swap is parsed as usual (the fee wallet is
// not in it, so its terminal fee reads 0), then the fee transaction's SOL
// out (every lamport that left the payer, less the transaction fee) is
// added as terminal fee, its transaction fee as network, both to what the
// user gave. Returns the swap's transaction for the pricing step.
func feeTxSwap(ctx context.Context, rpc *rpcClient, t Terminal, feeSig string, feeTx *parsedTx, solUSD float64) (*Swap, *parsedTx, parseReject) {
	msg := feeTx.Transaction.Message
	if len(msg.AccountKeys) == 0 || len(feeTx.Meta.PreBalances) != len(msg.AccountKeys) {
		return nil, nil, rejectNotSwap
	}
	payer := msg.AccountKeys[0].Pubkey
	feeOut := float64(int64(feeTx.Meta.PreBalances[0])-int64(feeTx.Meta.PostBalances[0])) / 1e9
	txFee := float64(feeTx.Meta.Fee) / 1e9
	feeOut -= txFee
	if feeOut <= 0 {
		return nil, nil, rejectNotSwap
	}
	prev, err := rpc.signaturesBefore(ctx, payer, feeSig, 1)
	if err != nil || len(prev) == 0 {
		return nil, nil, "no_swap_before_fee"
	}
	if prev[0].failed() {
		return nil, nil, "swap_before_fee_failed"
	}
	if prev[0].BlockTime != nil && feeTx.BlockTime != nil && *feeTx.BlockTime-*prev[0].BlockTime > 300 {
		return nil, nil, "no_swap_before_fee" // the fee transaction did not follow a swap within five minutes
	}
	swapTx, err := rpc.transaction(ctx, prev[0].Signature)
	if err != nil || swapTx == nil {
		return nil, nil, "unreadable"
	}
	sw, reject := parseSwap(t, prev[0].Signature, swapTx, solUSD, payer)
	if reject != "" {
		return nil, nil, reject
	}
	// The fee transaction's amounts in the swap's quote unit.
	q := 1.0
	if sw.Quote != "SOL" && sw.QuoteUSD > 0 {
		q = solUSD / sw.QuoteUSD
	}
	sw.TerminalQ += feeOut * q
	sw.NetworkQ += txFee * q
	if sw.Side == "buy" {
		sw.UserQ += (feeOut + txFee) * q
	} else {
		sw.UserQ -= (feeOut + txFee) * q // received net of the fee paid right after
	}
	sw.FeeSig = feeSig
	return sw, swapTx, ""
}

// repriceVenues: REPRICE_VENUES (comma-separated venues) prices the
// window's stored Solana rows of those venues again with the current
// code, one transaction read each, on the first tick after a start: a
// reference fix then applies to the whole window at once (the pump.fun
// curve's TradeEvent reference on 2026-09-21) instead of waiting for the
// window to turn over. The variable stays in the container's env until
// the next deploy resets it, like the purge variables; a second pass
// after a restart re-reads the same rows, harmless.
func repriceVenues(ctx context.Context, rpc *rpcClient, st *State, pools *poolCache, solUSD float64, now int64) {
	venues := set(strings.Split(os.Getenv("REPRICE_VENUES"), ",")...)
	delete(venues, "")
	if len(venues) == 0 {
		return
	}
	done, failed := 0, 0
	for i := range st.Swaps {
		s := &st.Swaps[i]
		if !venues[s.Venue] || s.Chain != "" || s.RelayID != "" {
			continue
		}
		tx, err := rpc.transaction(ctx, s.Sig)
		if err != nil || tx == nil {
			failed++
			continue
		}
		s.RefPrice, s.RefSrc, s.RefAgeS, s.LossBps, s.PoolBps, s.Priced, s.Flag = nil, "", nil, nil, nil, false, ""
		priceSwap(ctx, rpc, s, tx, pools, solUSD, now)
		done++
	}
	log.Printf("[state] REPRICE_VENUES=%q: %d rows priced again, %d unreadable", os.Getenv("REPRICE_VENUES"), done, failed)
}

// sizeAcc collects one trade-size bucket's raw figures while the window is
// walked; sizeSplit turns it into the published row.
type sizeAcc struct {
	parsed                              int
	loss, pool, term, net, relay, other []float64
	trade                               []float64
	// The same per-swap weights the pooled row uses, in the same order, so a
	// bucket's loss and trade size are the same weighted quantile.
	lossW, termW, netW, relayW, otherW, poolW, tradeW []float64
}

// SizeStats is one bucket's row: the same shape the All-sizes row has, so
// the site can render a size view with the queries it already knows.
type SizeStats struct {
	Loss       *Quantiles         `json:"loss_bps,omitempty"`
	Components map[string]float64 `json:"components,omitempty"`
	TradeUSD   *Quantiles         `json:"trade_usd,omitempty"`
	Priced     int                `json:"priced"`
	Parsed     int                `json:"parsed"`
	Healthy    bool               `json:"healthy"`
	Ranked     bool               `json:"ranked"`
}

// sizeSplit computes each bucket's row. Plain medians, not the flow-weighted
// rule the All-sizes row uses: that rule exists so a product whose chains
// charge differently does not land on one chain's mode, and inside a single
// size bucket of a single product there is no such mix to correct for. A
// bucket under minPriced publishes nothing at all rather than a median of
// five swaps; between the two floors it publishes unranked.
func sizeSplit(acc map[string]*sizeAcc, minPriced, minRank int, pooled bool) map[string]*SizeStats {
	if len(acc) == 0 {
		return nil
	}
	out := map[string]*SizeStats{}
	for b, a := range acc {
		if len(a.loss) < minPriced {
			continue
		}
		st := &SizeStats{
			Loss:       wquantiles(a.loss, a.lossW, true, pooled),
			Components: map[string]float64{},
			Priced:     len(a.loss),
			Parsed:     a.parsed,
			Healthy:    true,
			Ranked:     len(a.loss) >= minRank,
		}
		if len(a.trade) > 0 {
			st.TradeUSD = wquantiles(a.trade, a.tradeW, false, pooled)
		}
		// Single-row entry: the same weighted median the row itself uses.
		// A pooled entry overwrites these with the chain-weighted rule right
		// after, so both views of a product share one estimator.
		st.Components["terminal"] = wmedian(a.term, a.termW, pooled)
		st.Components["network"] = wmedian(a.net, a.netW, pooled)
		if len(a.pool) > 0 {
			st.Components["pool"] = wmedian(a.pool, a.poolW, pooled)
		}
		// Relay and Protocol are carried by part of the flow only: a median
		// over the rows that have them describes those rows, not the bucket,
		// so they are published only when they cover at least half of it.
		if len(a.relay)*2 >= a.parsed {
			st.Components["relay"] = wmedian(a.relay, a.relayW, pooled)
		}
		if len(a.other)*2 >= a.parsed {
			st.Components["other"] = wmedian(a.other, a.otherW, pooled)
		}
		out[b] = st
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// publishSizeGauges writes each bucket under the same metric names as the
// All-sizes row, one `bucket` label apart, which is what lets the site's
// dimension mechanism swap a pinned bucket="all" for the reader's choice.
// Fail rate and failure overhead stay out: a failed attempt never reached a
// pool and has no trade size to bucket it by.
func publishSizeGauges(ts TerminalStats) {
	for b, st := range ts.SizeSplit {
		if st.Loss != nil {
			gLoss.WithLabelValues(ts.Product, ts.Chain, "median", b).Set(st.Loss.Median)
			gLoss.WithLabelValues(ts.Product, ts.Chain, "p90", b).Set(st.Loss.P90)
			gLoss.WithLabelValues(ts.Product, ts.Chain, "p99", b).Set(st.Loss.P99)
		}
		for c, v := range st.Components {
			gComponent.WithLabelValues(ts.Product, ts.Chain, c, b).Set(v)
		}
		if st.TradeUSD != nil {
			gTrade.WithLabelValues(ts.Product, ts.Chain, "median", b).Set(st.TradeUSD.Median)
			gTrade.WithLabelValues(ts.Product, ts.Chain, "p90", b).Set(st.TradeUSD.P90)
			gTrade.WithLabelValues(ts.Product, ts.Chain, "p99", b).Set(st.TradeUSD.P99)
			if st.Loss != nil {
				gLostUSD.WithLabelValues(ts.Product, ts.Chain, b).Set(st.TradeUSD.Median * st.Loss.Median / 1e4)
			}
		}
		gSamples.WithLabelValues(ts.Product, ts.Chain, "priced", b).Set(float64(st.Priced))
		gSamples.WithLabelValues(ts.Product, ts.Chain, "parsed", b).Set(float64(st.Parsed))
		gHealth.WithLabelValues(ts.Product, ts.Chain, b).Set(b2f(st.Healthy))
		gRanked.WithLabelValues(ts.Product, ts.Chain, b).Set(b2f(st.Ranked))
	}
}
