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
	"encoding/json"
	"log"
	"math"
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
	gHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_health", Help: "1 when the terminal has enough priced samples and a recent refresh",
	}, []string{"terminal"})
	gRefresh = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_last_refresh_unix", Help: "Last successful tick"})
	gSol     = prometheus.NewGauge(prometheus.GaugeOpts{Name: "tfq_sol_usd", Help: "SOL/USD used for sizing"})
	cCalls   = prometheus.NewCounter(prometheus.CounterOpts{Name: "tfq_rpc_calls_total", Help: "RPC calls"})
	cErrors  = prometheus.NewCounter(prometheus.CounterOpts{Name: "tfq_rpc_errors_total", Help: "RPC errors and rate limits"})
)

func init() {
	prometheus.MustRegister(gLoss, gComponent, gFail, gSamples, gTrade, gVenue, gBuy, gHealth, gRefresh, gSol, cCalls, cErrors)
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
	Healthy     bool               `json:"healthy"`
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
	tick := time.Duration(envInt("TICK_SECONDS", 90)) * time.Second
	samplePerTick := envInt("SAMPLE_PER_TICK", 4)
	windowHours := envInt("WINDOW_HOURS", 24)
	minPriced := envInt("MIN_PRICED", 20)
	stateFile := os.Getenv("STATE_FILE")
	publicFile := os.Getenv("HISTORY_FILE_PUBLIC")
	addr := os.Getenv("METRICS_ADDR")
	if addr == "" {
		addr = ":2112"
	}
	log.Printf("OpenChainBench #268: terminal fill quality, %d terminals | tick=%s sample=%d/terminal window=%dh", len(terminals), tick, samplePerTick, windowHours)

	httpc := &http.Client{Timeout: 60 * time.Second}
	rps := envInt("RPC_RPS", 8)
	rpc := &rpcClient{url: rpcURL, http: httpc, calls: cCalls.Inc, errors: cErrors.Inc, minGap: time.Second / time.Duration(max(rps, 1))}

	st := loadState(stateFile)
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
		added, seen := sample(ctx, rpc, httpc, st, samplePerTick, sol)
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
		log.Printf("[tick] %s: %d signatures seen, %d swaps added, %d in window, %s", start.UTC().Format(time.RFC3339), seen, added, len(st.Swaps), time.Since(start).Round(100*time.Millisecond))
		time.Sleep(time.Until(start.Add(tick)))
	}
}

// sample scans every fee wallet for new signatures, records each one for
// the fail rate, reads the newest successful ones (newest first, so the
// reference price is read as close to the trade as possible), then prices
// the whole batch in one Jupiter call.
func sample(ctx context.Context, rpc *rpcClient, httpc *http.Client, st *State, perTerminal int, solUSD float64) (added, seen int) {
	now := time.Now().Unix()
	var batch []*Swap
	for _, t := range terminals {
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
				// Back off on quiet wallets (Axiom rotates 20): 2, 4, 8… ticks, max ~1h.
				cur.Idle++
				cur.NextScan = now + int64(math.Min(3600, 180*math.Pow(2, float64(cur.Idle))))
				continue
			}
			cur.Idle = 0
			cur.NextScan = 0
			if cur.Last == "" {
				// First scan: only the newest page; older history is not needed.
				sigs = sigs[:min(len(sigs), 40)]
			}
			cur.Last = sigs[0].Signature
			fresh = append(fresh, sigs...)
		}
		seen += len(fresh)
		var ok []sigInfo
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
		sort.SliceStable(ok, func(i, j int) bool { return ok[i].Slot > ok[j].Slot })
		if len(ok) > perTerminal {
			ok = ok[:perTerminal]
		}
		for _, s := range ok {
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
			// Arrival price: the previous trade on the same pool.
			if sw.PoolVault != "" {
				if p, age, ok := arrivalPrice(ctx, rpc, sw, solUSD); ok {
					sw.finalize(&p, age, "pool")
				}
			}
			batch = append(batch, sw)
		}
	}
	if len(batch) > 0 {
		mints := map[string]bool{}
		for _, sw := range batch {
			mints[sw.Mint] = true
		}
		ids := make([]string, 0, len(mints))
		for m := range mints {
			ids = append(ids, m)
		}
		pctx, pcancel := context.WithTimeout(context.Background(), 20*time.Second)
		prices, err := tokenPrices(pctx, httpc, ids)
		pcancel()
		if err != nil {
			log.Printf("[price] jupiter: %v (%d of %d mints priced)", err, len(prices), len(ids))
		}
		at := time.Now().Unix()
		for _, sw := range batch {
			if !sw.Priced {
				if p, ok := prices[sw.Mint]; ok && sw.QuoteUSD > 0 {
					q := p / sw.QuoteUSD // USD per token → quote units per token
					sw.finalize(&q, at-sw.Time, "jupiter")
				}
			}
			st.Swaps = append(st.Swaps, *sw)
			added++
		}
	}
	return added, seen
}

// arrivalPrice returns the effective price (quote per token) of the last
// trade on the swap's pool before it, and how many seconds earlier that
// trade was. Up to three preceding transactions on the pool's token vault
// are read; the first one that moved both legs of the pool is the trade.
func arrivalPrice(ctx context.Context, rpc *rpcClient, sw *Swap, solUSD float64) (float64, int64, bool) {
	var out []sigInfo
	err := rpc.call(ctx, "getSignaturesForAddress", []any{sw.PoolVault, map[string]any{"limit": 3, "before": sw.Sig, "commitment": "confirmed"}}, &out)
	if err != nil {
		return 0, 0, false
	}
	for _, s := range out {
		if s.failed() {
			continue
		}
		tx, err := rpc.transaction(ctx, s.Signature)
		if err != nil || tx == nil {
			continue
		}
		p := poolTradePrice(tx, sw.PoolOwner, sw.Mint, sw.Quote, sw.QuoteUSD, solUSD, sw.Venue == "pump-curve")
		if p <= 0 {
			continue
		}
		age := int64(0)
		if s.BlockTime != nil {
			age = sw.Time - *s.BlockTime
		}
		if age > 1800 {
			return 0, 0, false // a stale print is no reference; Jupiter fallback
		}
		return p, age, true
	}
	return 0, 0, false
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
		var loss, pool, term, net, other, trade []float64
		buys := 0
		venues := map[string]int{}
		quotes := map[string]int{}
		for _, s := range st.Swaps {
			if s.Terminal != t.Slug {
				continue
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
			if s.Priced && s.LossBps != nil {
				ts.Priced++
				loss = append(loss, *s.LossBps)
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
		}
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
		h := 0.0
		if ts.Healthy {
			h = 1
		}
		gHealth.WithLabelValues(ts.Slug).Set(h)
	}
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
	log.Printf("[state] loaded %d swaps from %s", len(st.Swaps), path)
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
