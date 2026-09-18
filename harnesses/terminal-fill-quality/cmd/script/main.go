// terminal-fill-quality: what a swap costs the user on each Solana trading
// terminal / Telegram bot, measured on-chain.
//
// Feeds bench 268 (terminal-fill-quality), the /trading-apps hub and the
// "Trading app" view on /products/<slug>.
//
// Method. Every terminal takes its fee through known wallets (the lists
// DeFiLlama's adapters match on). getSignaturesForAddress on those
// wallets yields every transaction the terminal routed, failed ones
// included; a sample of the successful ones is read with getTransaction.
// A Solana transaction carries the pre/post SOL and token balances of
// every account it touches, so for each sampled swap we know exactly what
// the user paid, what the pool received, what the terminal, the network
// (priority fee + Jito tip) and everyone else took, and what the user got.
// The received tokens are valued at the pool's own mid price before the
// swap, read from the pool's vault balances in the same transaction
// (arrival price), so the figure is what a TCA desk would compute:
// implementation shortfall, not marketing slippage. See parse.go.
//
// Failed transactions are counted from the signature scan: the user paid
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
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	gLoss = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_loss_bps", Help: "Value lost per swap vs the pool's pre-trade mid, basis points of the trade (priced samples, rolling window)",
	}, []string{"terminal", "stat"})
	gComponent = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_component_bps", Help: "Median cost component per swap, basis points of the trade",
	}, []string{"terminal", "component"})
	gFail = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_fail_rate_pct", Help: "Share of the terminal's transactions that failed on-chain, percent (rolling window, every signature seen)",
	}, []string{"terminal"})
	gSamples = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_sample_size", Help: "Samples in the window: seen (signatures), parsed (swaps), priced (with a loss figure)",
	}, []string{"terminal", "kind"})
	gTrade = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_trade_usd", Help: "Sampled trade size in USD",
	}, []string{"terminal", "stat"})
	gVenue = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_venue_share_pct", Help: "Share of sampled swaps per venue",
	}, []string{"terminal", "venue"})
	gBuy = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_buy_share_pct", Help: "Share of sampled swaps that are buys",
	}, []string{"terminal"})
	gSandwich = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_sandwich_pct", Help: "Share of scanned swaps that were sandwiched in their block (front-run and back-run by the same signer on the same pool)",
	}, []string{"terminal"})
	gSandwichProfit = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_sandwich_profit_bps", Help: "Median attacker profit on sandwiched swaps, basis points of the victim's trade",
	}, []string{"terminal"})
	gLossSize = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_loss_bps_size", Help: "Median loss per swap by trade-size bucket (under25, 25to250, over250 USD)",
	}, []string{"terminal", "bucket"})
	gHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_health", Help: "1 when the terminal has enough priced samples and a recent refresh",
	}, []string{"terminal"})
	gRefresh = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_last_refresh_unix", Help: "Last successful tick"})
	gSol     = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_sol_usd", Help: "SOL/USD used for sizing"})
	cCalls   = prometheus.NewCounter(prometheus.CounterOpts{Name: "tfq_rpc_calls_total", Help: "RPC calls"})
	cErrors  = prometheus.NewCounter(prometheus.CounterOpts{Name: "tfq_rpc_errors_total", Help: "RPC errors and rate limits"})
)

func init() {
	prometheus.MustRegister(gLoss, gComponent, gFail, gSamples, gTrade, gVenue, gBuy, gSandwich, gSandwichProfit, gLossSize, gHealth, gRefresh, gSol, cCalls, cErrors)
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// sigEvent is one signature seen on a fee wallet: kept for the fail rate.
type sigEvent struct {
	Time   int64 `json:"t"`
	Failed bool  `json:"f"`
}

type walletCursor struct {
	Last     string `json:"last"` // newest signature already scanned
	Idle     int    `json:"idle"` // consecutive empty scans, for backoff
	NextScan int64  `json:"next"`
}

type State struct {
	Swaps   []Swap                    `json:"swaps"`
	Events  map[string][]sigEvent     `json:"events"`  // terminal -> signature events
	Rejects map[string]map[string]int `json:"rejects"` // terminal -> reason -> count (window not enforced; informative)
	Cursors map[string]*walletCursor  `json:"cursors"` // wallet -> cursor
}

type TerminalStats struct {
	Slug        string             `json:"slug"`
	Name        string             `json:"name"`
	Kind        string             `json:"kind"`
	Note        string             `json:"note,omitempty"`
	Seen        int                `json:"seen"`
	Failed      int                `json:"failed"`
	FailRate    *float64           `json:"fail_rate_pct,omitempty"`
	Parsed      int                `json:"parsed"`
	Priced      int                `json:"priced"`
	Loss        *Quantiles         `json:"loss_bps,omitempty"`
	Components  map[string]float64 `json:"components_bps"` // medians
	TradeUSD    *Quantiles         `json:"trade_usd,omitempty"`
	BuySharePct float64            `json:"buy_share_pct"`
	Venues      map[string]float64 `json:"venue_share_pct"`
	Quotes      map[string]float64 `json:"quote_share_pct"`
	Rejects     map[string]int     `json:"rejects,omitempty"`
	/** Share of priced samples by reference source: reserves (exact mid), pool (previous trade), jupiter. */
	RefPoolPct float64            `json:"ref_pool_pct"`
	RefSrcPct  map[string]float64 `json:"ref_src_pct"`
	/** Sandwich scan: swaps whose block was read, how many were sandwiched, attacker profit. */
	Scanned        int        `json:"scanned"`
	Sandwiched     int        `json:"sandwiched"`
	SandwichPct    *float64   `json:"sandwich_pct,omitempty"`
	SandwichProfit *Quantiles `json:"sandwich_profit_bps,omitempty"`
	/** Loss by trade-size bucket. */
	BySize map[string]*Quantiles `json:"by_size,omitempty"`
	/** Largest "other" recipients over the window, for audit: pubkey, count, share of trade in bps (median). */
	OtherTop []OtherRecipient `json:"other_top,omitempty"`
	Healthy  bool             `json:"healthy"`
}

type OtherRecipient struct {
	Pubkey string  `json:"pubkey"`
	Count  int     `json:"count"`
	Quote  float64 `json:"quote_sum"`
}

type Quantiles struct {
	Median float64 `json:"median"`
	Mean   float64 `json:"mean"`
	P90    float64 `json:"p90"`
	N      int     `json:"n"`
}

type Public struct {
	GeneratedAt string          `json:"generated_at"`
	WindowHours int             `json:"window_hours"`
	SolUSD      float64         `json:"sol_usd"`
	Method      string          `json:"method"`
	Terminals   []TerminalStats `json:"terminals"`
	Recent      []Swap          `json:"recent"`
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
	windowHours := envInt("WINDOW_HOURS", 24)
	minPriced := envInt("MIN_PRICED", 20)
	useWS := envInt("WS", 1) == 1
	minTradeUSD = float64(envInt("MIN_TRADE_USD", 2))
	stateFile := os.Getenv("STATE_FILE")
	publicFile := os.Getenv("HISTORY_FILE_PUBLIC")
	addr := os.Getenv("METRICS_ADDR")
	if addr == "" {
		addr = ":2112"
	}
	log.Printf("OpenChainBench #268: terminal fill quality, %d terminals | tick=%s target=%d swaps/terminal/day window=%dh ws=%v", len(terminals), tick, dailyTarget, windowHours, useWS)

	httpc := &http.Client{Timeout: 60 * time.Second}
	rps := envInt("RPC_RPS", 8)
	rpc := &rpcClient{url: rpcURL, http: httpc, calls: cCalls.Inc, errors: cErrors.Inc, minGap: time.Second / time.Duration(max(rps, 1))}

	st := loadState(stateFile)
	pools := &poolCache{m: map[string]poolParams{}}
	quota := map[string]float64{}
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
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		if p, err := solPrice(ctx, httpc); err == nil && p > 0 {
			sol = p
			gSol.Set(p)
		} else if sol == 0 {
			log.Printf("[price] pyth: %v (no SOL price yet, sizing skipped this tick)", err)
		}
		start := time.Now()
		if sol == 0 {
			cancel()
			log.Printf("[price] no SOL price, retrying in 30s")
			time.Sleep(30 * time.Second)
			continue
		}
		added, seen := sample(ctx, rpc, st, sol, pools, fd, quota, perTick)
		cancel()
		prune(st, windowHours)
		stats := compute(st, windowHours, minPriced, start)
		publishGauges(stats)
		gRefresh.Set(float64(time.Now().Unix()))
		p := &Public{
			GeneratedAt: time.Now().UTC().Format(time.RFC3339), WindowHours: windowHours, SolUSD: sol,
			Method:    "Sampled swaps read on-chain from each terminal's fee-wallet transactions; loss = 1 − value received at the pool's pre-trade mid / value given, in basis points; components exact from balance deltas.",
			Terminals: stats, Recent: recent(st, 200),
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
		live := fd != nil && fd.healthy()
		log.Printf("[tick] %s: %d signatures seen (%s), %d swaps added, %d in window, %s", start.UTC().Format(time.RFC3339), seen, map[bool]string{true: "ws", false: "poll"}[live], added, len(st.Swaps), time.Since(start).Round(100*time.Millisecond))
		time.Sleep(time.Until(start.Add(tick)))
	}
}

// sample drains the live feed (or, when the feed is down, polls the fee
// wallets), records every signature for the fail rate, draws the tick's
// quota of successful ones at random and reads them.
//
// Quota: DAILY_TARGET swaps per terminal per day, spread over the ticks
// (fractional carry), so the sample size follows the precision wanted for
// a median rather than the tick length.
func sample(ctx context.Context, rpc *rpcClient, st *State, solUSD float64, pools *poolCache, fd *feed, quota map[string]float64, perTick float64) (added, seen int) {
	now := time.Now().Unix()
	live := fd != nil && fd.healthy()
	for _, t := range terminals {
		var fresh []sigInfo
		var ok []sigInfo
		if live {
			nSeen, nFailed, reservoir := fd.drain(t.Slug)
			seen += nSeen
			for i := 0; i < nSeen; i++ {
				st.Events[t.Slug] = append(st.Events[t.Slug], sigEvent{Time: now, Failed: i < nFailed})
			}
			ok = reservoir
		} else {
			// Polling fallback: newest page per wallet since the last cursor.
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
			for _, s := range fresh {
				ts := now
				if s.BlockTime != nil {
					ts = *s.BlockTime
				}
				st.Events[t.Slug] = append(st.Events[t.Slug], sigEvent{Time: ts, Failed: s.failed()})
				if !s.failed() {
					ok = append(ok, s)
				}
			}
			rand.Shuffle(len(ok), func(i, j int) { ok[i], ok[j] = ok[j], ok[i] })
		}
		// Draw this tick's quota at random.
		quota[t.Slug] += perTick
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
			sw, reject := parseSwap(t, s.Signature, tx, solUSD)
			if reject != "" {
				if st.Rejects[t.Slug] == nil {
					st.Rejects[t.Slug] = map[string]int{}
				}
				st.Rejects[t.Slug][string(reject)]++
				continue
			}
			if sw.Time == 0 {
				sw.Time = now
			}
			// Reference price: exact pre-trade mid from the pool's reserves
			// when the route is one constant-product pool.
			if sw.PoolBasePre > 0 && sw.PoolQuotePre > 0 {
				if p, ok := reservePrice(ctx, rpc, sw, pools, solUSD); ok {
					sw.finalize(&p, 0, "reserves")
				}
			}
			// Pool neighbourhood: previous trade (reference price when the
			// reserves did not give one) and the sandwich screen.
			if sw.PoolVault != "" {
				if nb, err := poolNeighbours(ctx, rpc, sw); err == nil {
					var prevTx *parsedTx
					for i, ps := range nb.prev {
						ptx, err := rpc.transaction(ctx, ps.Signature)
						if err != nil || ptx == nil {
							continue
						}
						if i == 0 {
							prevTx = ptx
						}
						if sw.Priced {
							break // only the immediate neighbour is needed for the screen
						}
						if p := poolTradePrice(ptx, sw.PoolOwner, sw.Mint, sw.Quote, sw.QuoteUSD, solUSD, sw.Venue == "pump-curve"); p > 0 {
							age := int64(0)
							if ps.BlockTime != nil {
								age = sw.Time - *ps.BlockTime
							}
							if age <= 1800 {
								sw.finalize(&p, age, "pool")
							}
							break
						}
					}
					if sd, ok := screenSandwich(ctx, rpc, sw, nb, prevTx, solUSD); ok {
						sw.Scanned = true
						sw.Sandwich = sd
						sw.BlockPoolTxs = len(nb.prev)
					}
				}
			}
			st.Swaps = append(st.Swaps, *sw)
			added++
		}
	}
	return added, seen
}

// poolParams are the constants a pool needs for its exact mid: the
// virtual quote offset (PumpSwap migrated pools, pump.fun curve) and the
// virtual token offset plus the non-reserve lamports of the curve account.
// Stored in raw units (SOL, tokens) and converted to the swap's quote
// unit at use time: the cache is shared by swaps quoted in SOL and in
// stables on the same pool.
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
	for k, evs := range st.Events {
		out := evs[:0]
		for _, e := range evs {
			if e.Time >= cut {
				out = append(out, e)
			}
		}
		st.Events[k] = out
	}
}

func compute(st *State, windowHours, minPriced int, now time.Time) []TerminalStats {
	out := make([]TerminalStats, 0, len(terminals))
	for _, t := range terminals {
		ts := TerminalStats{Slug: t.Slug, Name: t.Name, Kind: t.Kind, Note: t.Note, Components: map[string]float64{}, Venues: map[string]float64{}, Quotes: map[string]float64{}, Rejects: st.Rejects[t.Slug]}
		for _, e := range st.Events[t.Slug] {
			ts.Seen++
			if e.Failed {
				ts.Failed++
			}
		}
		if ts.Seen >= 20 {
			fr := 100 * float64(ts.Failed) / float64(ts.Seen)
			ts.FailRate = &fr // percent
		}
		var loss, pool, term, net, other, trade, sandProfit []float64
		bySize := map[string][]float64{}
		refSrc := map[string]int{}
		buys := 0
		refPool := 0
		venues := map[string]int{}
		quotes := map[string]int{}
		otherAgg := map[string]*OtherRecipient{}
		for _, s := range st.Swaps {
			if s.Terminal != t.Slug {
				continue
			}
			if s.RefSrc == "pool" {
				refPool++
			}
			if s.RefSrc != "" && s.RefSrc != "jupiter" {
				refSrc[s.RefSrc]++
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
					otherAgg[k] = r
				}
				r.Count++
				r.Quote += v * s.QuoteUSD
			}
			ts.Parsed++
			term = append(term, s.TerminalBps)
			net = append(net, s.NetworkBps)
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
			if s.Priced && s.LossBps != nil && s.RefSrc != "jupiter" {
				ts.Priced++
				loss = append(loss, *s.LossBps)
				bySize[sizeBucket(s.TradeUSD)] = append(bySize[sizeBucket(s.TradeUSD)], *s.LossBps)
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
			ts.BuySharePct = 100 * float64(buys) / float64(ts.Parsed)
			for v, c := range venues {
				ts.Venues[v] = 100 * float64(c) / float64(ts.Parsed)
			}
			for q, c := range quotes {
				ts.Quotes[q] = 100 * float64(c) / float64(ts.Parsed)
			}
		}
		if len(trade) > 0 {
			ts.TradeUSD = quantiles(trade)
		}
		if ts.Priced > 0 {
			ts.Loss = quantiles(loss)
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
					ts.BySize[b] = quantiles(v)
				}
			}
		}
		if ts.Scanned >= 20 {
			p := 100 * float64(ts.Sandwiched) / float64(ts.Scanned)
			ts.SandwichPct = &p
		}
		if len(sandProfit) > 0 {
			ts.SandwichProfit = quantiles(sandProfit)
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
		out = append(out, ts)
	}
	sort.SliceStable(out, func(i, j int) bool {
		li, lj := math.Inf(1), math.Inf(1)
		if out[i].Loss != nil {
			li = out[i].Loss.Median
		}
		if out[j].Loss != nil {
			lj = out[j].Loss.Median
		}
		return li < lj
	})
	return out
}

func publishGauges(stats []TerminalStats) {
	for _, ts := range stats {
		if ts.Loss != nil && ts.Healthy {
			gLoss.WithLabelValues(ts.Slug, "median").Set(ts.Loss.Median)
			gLoss.WithLabelValues(ts.Slug, "mean").Set(ts.Loss.Mean)
			gLoss.WithLabelValues(ts.Slug, "p90").Set(ts.Loss.P90)
		} else {
			gLoss.DeletePartialMatch(prometheus.Labels{"terminal": ts.Slug})
		}
		for c, v := range ts.Components {
			gComponent.WithLabelValues(ts.Slug, c).Set(v)
		}
		if ts.FailRate != nil {
			gFail.WithLabelValues(ts.Slug).Set(100 * *ts.FailRate)
		} else {
			gFail.DeleteLabelValues(ts.Slug)
		}
		gSamples.WithLabelValues(ts.Slug, "seen").Set(float64(ts.Seen))
		gSamples.WithLabelValues(ts.Slug, "parsed").Set(float64(ts.Parsed))
		gSamples.WithLabelValues(ts.Slug, "priced").Set(float64(ts.Priced))
		if ts.TradeUSD != nil {
			gTrade.WithLabelValues(ts.Slug, "median").Set(ts.TradeUSD.Median)
			gTrade.WithLabelValues(ts.Slug, "mean").Set(ts.TradeUSD.Mean)
		}
		gVenue.DeletePartialMatch(prometheus.Labels{"terminal": ts.Slug})
		for v, p := range ts.Venues {
			gVenue.WithLabelValues(ts.Slug, v).Set(p)
		}
		gBuy.WithLabelValues(ts.Slug).Set(ts.BuySharePct)
		if ts.SandwichPct != nil {
			gSandwich.WithLabelValues(ts.Slug).Set(*ts.SandwichPct)
		} else {
			gSandwich.DeleteLabelValues(ts.Slug)
		}
		if ts.SandwichProfit != nil {
			gSandwichProfit.WithLabelValues(ts.Slug).Set(ts.SandwichProfit.Median)
		} else {
			gSandwichProfit.DeleteLabelValues(ts.Slug)
		}
		gLossSize.DeletePartialMatch(prometheus.Labels{"terminal": ts.Slug})
		for b, q := range ts.BySize {
			gLossSize.WithLabelValues(ts.Slug, b).Set(q.Median)
		}
		h := 0.0
		if ts.Healthy {
			h = 1
		}
		gHealth.WithLabelValues(ts.Slug).Set(h)
	}
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

func quantiles(v []float64) *Quantiles {
	if len(v) == 0 {
		return nil
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	sum := 0.0
	for _, x := range s {
		sum += x
	}
	return &Quantiles{Median: pct(s, 0.5), Mean: sum / float64(len(s)), P90: pct(s, 0.9), N: len(s)}
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
	st := &State{Events: map[string][]sigEvent{}, Rejects: map[string]map[string]int{}, Cursors: map[string]*walletCursor{}}
	if path == "" {
		return st
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return st
	}
	if err := json.Unmarshal(b, st); err != nil {
		log.Printf("[state] %s unreadable, starting empty: %v", path, err)
		return &State{Events: map[string][]sigEvent{}, Rejects: map[string]map[string]int{}, Cursors: map[string]*walletCursor{}}
	}
	if st.Events == nil {
		st.Events = map[string][]sigEvent{}
	}
	if st.Rejects == nil {
		st.Rejects = map[string]map[string]int{}
	}
	if st.Cursors == nil {
		st.Cursors = map[string]*walletCursor{}
	}
	// A reserve-based reference cannot yield a loss below about −1 %:
	// such rows come from a bug (a pool cache once stored converted
	// units); drop them rather than let them sit in the window.
	kept := st.Swaps[:0]
	dropped := 0
	for _, s := range st.Swaps {
		if s.RefSrc == "reserves" && s.LossBps != nil && *s.LossBps < -300 {
			dropped++
			continue
		}
		kept = append(kept, s)
	}
	st.Swaps = kept
	log.Printf("[state] loaded %d swaps from %s (%d dropped as implausible)", len(st.Swaps), path, dropped)
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
