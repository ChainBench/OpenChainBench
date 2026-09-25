// trading-app-volume: cross-chain daily volume per trading app / Telegram
// bot on closed UTC days, from DeFiLlama's free dexs summary endpoint.
//
// Feeds bench 267 (trading-app-daily-volume), the /trading-apps hub chart
// and the "Trading app" view on /products/<slug>.
//
// Why DeFiLlama here and not Dune: the Dune community datasets the
// /trading-apps hub used for volume cover one chain for some platforms
// (dataset_fomo_sol_daily is Solana only) and every chain for others, so
// the column compared unlike things. DeFiLlama's dexs adapters for the
// "Trading App" and "Telegram Bot" categories are cross-chain by
// construction and expose a per-chain breakdown per UTC day, on a free
// endpoint:
//
//	GET https://api.llama.fi/summary/dexs/<slug>?dataType=dailyVolume
//	  -> totalDataChart [[unix, usd]...], totalDataChartBreakdown
//	     [[unix, {chain: {version: usd}}]...]
//
// One call per app per tick returns the whole history, so there is no
// backfill machinery: every tick re-reads each app, keeps the last
// HISTORY_DAYS closed days, and the current (open) UTC day is dropped.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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

// App is one cohort member. slug is the OCB product slug (bench label
// app="<slug>"), llama the DeFiLlama dexs slug.
type App struct {
	Slug  string `json:"slug"`
	Name  string `json:"name"`
	Llama string `json:"llama_slug"`
	Kind  string `json:"kind"` // "app" (web / mobile terminal) or "bot" (Telegram)
	Note  string `json:"note,omitempty"`
	// ChainLabel replaces the chain split's text when DeFiLlama's chain
	// attribution is not where the trades happen (FOMO books every trade,
	// cross-chain ones included, on Solana).
	ChainLabel string `json:"chain_label,omitempty"`
}

// cohort: every DeFiLlama dexs protocol in the Trading App / Telegram Bot
// categories with meaningful volume on 2026-09-17, plus pump.fun's mobile
// app. Slugs follow the existing OCB product slugs where one exists
// (fomo, padre = Terminal, pump-fun, bloom).
var cohort = []App{
	{Slug: "gmgn", Name: "GMGN", Llama: "gmgn", Kind: "app"},
	{Slug: "axiom", Name: "Axiom", Llama: "axiom", Kind: "app"},
	{Slug: "fomo", Name: "FOMO", Llama: "fomo-wallet", Kind: "app", Note: "Measured on Solana, where FOMO holds user balances; cross-chain buys and sells executed through Relay are included and counted once, so this is FOMO's total, not its Solana-native share.", ChainLabel: "Settled on Solana · cross-chain via Relay"},
	{Slug: "padre", Name: "Terminal", Llama: "terminal", Kind: "bot", Note: "pump.fun's own trading app, formerly Padre."},
	{Slug: "pump-fun", Name: "pump.fun app", Llama: "pump.fun-mobile-app", Kind: "app", Note: "The pump.fun mobile app only, not the launchpad's bonding-curve volume."},
	{Slug: "photon", Name: "Photon", Llama: "photon", Kind: "app"},
	{Slug: "trojan", Name: "Trojan", Llama: "trojan", Kind: "bot"},
	{Slug: "bullx", Name: "BullX", Llama: "bullx", Kind: "bot"},
	{Slug: "bonkbot", Name: "BONKbot", Llama: "bonkbot", Kind: "bot"},
	{Slug: "banana-gun", Name: "Banana Gun", Llama: "banana-gun", Kind: "bot"},
	{Slug: "bloom", Name: "Bloom", Llama: "bloom-trading-bot", Kind: "bot"},
	{Slug: "soltradingbot", Name: "SolTradingBot", Llama: "soltradingbot", Kind: "bot"},
	{Slug: "pepeboost", Name: "Pepeboost", Llama: "pepeboost", Kind: "bot"},
	{Slug: "o1-exchange", Name: "o1.exchange", Llama: "o1.exchange-trading-terminal", Kind: "app"},
}

// DayPoint is one closed UTC day of one app.
type DayPoint struct {
	Day    string             `json:"day"`
	USD    float64            `json:"usd"`
	Chains map[string]float64 `json:"chains,omitempty"`
}

type AppHistory struct {
	App
	Chains []string   `json:"chains"`
	Days   []DayPoint `json:"days"`
	// LastDay is the latest closed UTC day DeFiLlama has for this app. Most
	// adapters are Dune queries that refuse to run until 10 h after the
	// day closed, so early in the UTC day it trails the cohort's
	// last_closed_day by one day (GMGN's adapter also skips days); every
	// per-app figure is anchored here, not on the cohort day.
	LastDay string `json:"last_day,omitempty"`
	// Fetched is when this app's series was last read successfully.
	Fetched string `json:"fetched_at"`
	Error   string `json:"error,omitempty"`
}

type History struct {
	GeneratedAt   string       `json:"generated_at"`
	LastClosedDay string       `json:"last_closed_day"`
	Source        string       `json:"source"`
	Apps          []AppHistory `json:"apps"`
}

var (
	gVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_app_volume_usd",
		Help: "Cross-chain trading volume in USD per app: window=1d is the last closed UTC day, 7d and 30d are sums over the last N closed days (published from 80 percent day coverage; see trading_app_window_days).",
	}, []string{"app", "window"})
	gChain = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_app_volume_chain_usd",
		Help: "Volume in USD per app and chain on the last closed UTC day.",
	}, []string{"app", "chain"})
	gShare = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_app_volume_share_pct",
		Help: "Share of the cohort's volume per app on the window, in percent.",
	}, []string{"app", "window"})
	gCohort = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_app_cohort_volume_usd",
		Help: "Cohort total volume in USD on the window.",
	}, []string{"window"})
	gWindowDays = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_app_window_days",
		Help: "Days with a DeFiLlama point inside the 7d / 30d window (7 and 30 when complete). Sums are published from 80 percent coverage.",
	}, []string{"app", "window"})
	gDays = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_app_history_days",
		Help: "Closed UTC days stored per app (bench sample size).",
	}, []string{"app"})
	gLastDay = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_app_last_day_unix",
		Help: "UTC midnight (unix seconds) of the app's latest closed day on DeFiLlama; every window and chain gauge for the app ends on it.",
	}, []string{"app"})
	gChains = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_app_chains",
		Help: "Number of chains with volume on the app's latest closed day.",
	}, []string{"app"})
	gHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_app_health",
		Help: "1 when the app's latest closed day is within 3 days of yesterday UTC, else 0.",
	}, []string{"app"})
	gRefresh = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "trading_app_last_refresh_unix",
		Help: "Unix time of the last successful sweep.",
	})
	gErrors = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "trading_app_fetch_errors_total",
		Help: "DeFiLlama fetch failures per app.",
	}, []string{"app"})
)

func init() {
	prometheus.MustRegister(gVolume, gChain, gShare, gCohort, gWindowDays, gDays, gLastDay, gChains, gHealth, gRefresh, gErrors)
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	tick := time.Duration(envInt("TICK_MINUTES", 60)) * time.Minute
	historyDays := envInt("HISTORY_DAYS", 1500) // GMGN's DeFiLlama series starts Sep 2023
	addr := os.Getenv("METRICS_ADDR")
	if addr == "" {
		addr = ":2112"
	}
	publicPath := os.Getenv("HISTORY_FILE_PUBLIC")
	base := os.Getenv("DEFILLAMA_BASE")
	if base == "" {
		base = "https://api.llama.fi"
	}

	fmt.Println("=== trading-app-volume harness ===")
	fmt.Printf("OpenChainBench #267: cross-chain daily volume per trading app, UTC days\n")
	fmt.Printf("apps=%d | history=%dd | tick=%s | source=%s | public=%s\n", len(cohort), historyDays, tick, base, publicPath)

	var (
		mu   sync.RWMutex
		last *History
	)
	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/v1/history", func(w http.ResponseWriter, r *http.Request) {
		mu.RLock()
		h := last
		mu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		if h == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"no sweep yet"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(h)
	})
	go func() {
		if err := http.ListenAndServe(addr, nil); err != nil {
			log.Fatalf("http: %v", err)
		}
	}()

	client := &http.Client{Timeout: 40 * time.Second}
	prev := map[string]AppHistory{}
	for {
		start := time.Now()
		h := sweep(client, base, historyDays, prev)
		for _, a := range h.Apps {
			if a.Error == "" {
				prev[a.Slug] = a
			}
		}
		publish(h)
		mu.Lock()
		last = h
		mu.Unlock()
		if publicPath != "" {
			if err := writeAtomic(publicPath, h); err != nil {
				log.Printf("public json: %v", err)
			}
		}
		ok := 0
		for _, a := range h.Apps {
			if a.Error == "" {
				ok++
			}
		}
		fmt.Printf("[sweep] %s: %d/%d apps ok, last closed day %s, %.1fs\n", h.GeneratedAt, ok, len(h.Apps), h.LastClosedDay, time.Since(start).Seconds())
		time.Sleep(tick)
	}
}

// sweep reads every app. An app whose fetch fails keeps its previous
// series (prev) and is flagged with Error, so one DeFiLlama hiccup never
// blanks a row.
func sweep(client *http.Client, base string, historyDays int, prev map[string]AppHistory) *History {
	now := time.Now().UTC()
	today := utcDay(now)
	lastClosed := today.AddDate(0, 0, -1)
	horizon := lastClosed.AddDate(0, 0, -historyDays+1)

	out := make([]AppHistory, 0, len(cohort))
	var wg sync.WaitGroup
	var mu sync.Mutex
	sem := make(chan struct{}, 4)
	for _, app := range cohort {
		wg.Add(1)
		go func(app App) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ah, err := fetchApp(client, base, app, horizon, lastClosed)
			if err != nil {
				gErrors.WithLabelValues(app.Slug).Inc()
				log.Printf("[%s] %v", app.Slug, err)
				if p, ok := prev[app.Slug]; ok {
					p.Error = err.Error()
					ah = p
				} else {
					ah = AppHistory{App: app, Error: err.Error()}
				}
			}
			mu.Lock()
			out = append(out, ah)
			mu.Unlock()
		}(app)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool {
		return lastDayUSD(out[i]) > lastDayUSD(out[j])
	})
	return &History{
		GeneratedAt:   now.Format(time.RFC3339),
		LastClosedDay: fmtDay(lastClosed),
		Source:        "defillama dexs summary (dailyVolume), free endpoint",
		Apps:          out,
	}
}

type llamaSummary struct {
	Chains                  []string          `json:"chains"`
	TotalDataChart          [][2]float64      `json:"totalDataChart"`
	TotalDataChartBreakdown []json.RawMessage `json:"totalDataChartBreakdown"`
}

// fetchApp reads one app's DeFiLlama summary and folds it into closed UTC
// days inside [horizon, lastClosed]. Breakdown rows are
// [unix, {chain: {adapterVersion: usd}}]; versions are summed per chain.
func fetchApp(client *http.Client, base string, app App, horizon, lastClosed time.Time) (AppHistory, error) {
	url := fmt.Sprintf("%s/summary/dexs/%s?dataType=dailyVolume", base, app.Llama)
	req, _ := http.NewRequestWithContext(context.Background(), "GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-TradingApps/1.0 (+https://openchainbench.com/benchmarks/trading-app-daily-volume)")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return AppHistory{}, fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return AppHistory{}, fmt.Errorf("status %d", resp.StatusCode)
	}
	var s llamaSummary
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return AppHistory{}, fmt.Errorf("decode: %w", err)
	}

	byDay := map[string]*DayPoint{}
	for _, row := range s.TotalDataChart {
		d := utcDay(time.Unix(int64(row[0]), 0))
		if d.Before(horizon) || d.After(lastClosed) {
			continue
		}
		byDay[fmtDay(d)] = &DayPoint{Day: fmtDay(d), USD: row[1]}
	}
	chainSet := map[string]bool{}
	for _, raw := range s.TotalDataChartBreakdown {
		var row []json.RawMessage
		if err := json.Unmarshal(raw, &row); err != nil || len(row) != 2 {
			continue
		}
		var ts float64
		if err := json.Unmarshal(row[0], &ts); err != nil {
			continue
		}
		d := fmtDay(utcDay(time.Unix(int64(ts), 0)))
		p, ok := byDay[d]
		if !ok {
			continue
		}
		var chains map[string]map[string]float64
		if err := json.Unmarshal(row[1], &chains); err != nil {
			// Some adapters emit {chain: usd} without a version level.
			var flat map[string]float64
			if err2 := json.Unmarshal(row[1], &flat); err2 != nil {
				continue
			}
			chains = map[string]map[string]float64{}
			for c, v := range flat {
				chains[c] = map[string]float64{"": v}
			}
		}
		p.Chains = map[string]float64{}
		for c, versions := range chains {
			var sum float64
			for _, v := range versions {
				sum += v
			}
			if sum > 0 {
				p.Chains[c] = sum
				chainSet[c] = true
			}
		}
	}
	days := make([]DayPoint, 0, len(byDay))
	for _, p := range byDay {
		days = append(days, *p)
	}
	sort.Slice(days, func(i, j int) bool { return days[i].Day < days[j].Day })
	chains := make([]string, 0, len(chainSet))
	for c := range chainSet {
		chains = append(chains, c)
	}
	sort.Strings(chains)
	lastDay := ""
	if len(days) > 0 {
		lastDay = days[len(days)-1].Day
	}
	return AppHistory{App: app, Chains: chains, Days: days, LastDay: lastDay, Fetched: time.Now().UTC().Format(time.RFC3339)}, nil
}

func lastDayUSD(a AppHistory) float64 {
	if len(a.Days) == 0 {
		return 0
	}
	return a.Days[len(a.Days)-1].USD
}

// publish writes the gauges from a sweep. DeFiLlama series have gaps
// (GMGN has no points for 2026-08-26..31), so window sums are published
// from 80 percent day coverage with the coverage alongside; below that
// the window is dropped rather than shown as a low week.
func publish(h *History) {
	lastClosed, _ := parseDay(h.LastClosedDay)
	windows := map[string]int{"1d": 1, "7d": 7, "30d": 30}
	totals := map[string]float64{}
	perApp := map[string]map[string]float64{}
	for _, a := range h.Apps {
		byDay := map[string]DayPoint{}
		for _, d := range a.Days {
			byDay[d.Day] = d
		}
		perApp[a.Slug] = map[string]float64{}
		// Windows end on the app's own latest closed day (see LastDay). An
		// app with no day at all publishes nothing.
		end, err := parseDay(a.LastDay)
		if a.LastDay == "" || err != nil {
			for w := range windows {
				gVolume.DeleteLabelValues(a.Slug, w)
				gWindowDays.WithLabelValues(a.Slug, w).Set(0)
			}
			gLastDay.DeleteLabelValues(a.Slug)
			gChain.DeletePartialMatch(prometheus.Labels{"app": a.Slug})
			gChains.WithLabelValues(a.Slug).Set(0)
			gHealth.WithLabelValues(a.Slug).Set(0)
			gDays.WithLabelValues(a.Slug).Set(float64(len(a.Days)))
			continue
		}
		gLastDay.WithLabelValues(a.Slug).Set(float64(end.Unix()))
		// An adapter that stopped publishing must not keep full windows and
		// chain gauges alive on its last day: past 72 h behind the cohort the
		// windows snap back to the cohort day (and go absent), while
		// trading_app_last_day_unix keeps the real day and health reads 0.
		if lastClosed.Sub(end) > 72*time.Hour {
			end = lastClosed
		}
		for w, n := range windows {
			var sum float64
			present := 0
			for i := 0; i < n; i++ {
				d := fmtDay(end.AddDate(0, 0, -i))
				if p, ok := byDay[d]; ok {
					sum += p.USD
					present++
				}
			}
			gWindowDays.WithLabelValues(a.Slug, w).Set(float64(present))
			if present > 0 && float64(present) >= 0.8*float64(n) {
				gVolume.WithLabelValues(a.Slug, w).Set(sum)
				perApp[a.Slug][w] = sum
				totals[w] += sum
			} else {
				gVolume.DeleteLabelValues(a.Slug, w)
			}
		}
		gDays.WithLabelValues(a.Slug).Set(float64(len(a.Days)))
		// Per-chain gauges for the app's latest closed day; stale chains are removed.
		gChain.DeletePartialMatch(prometheus.Labels{"app": a.Slug})
		nChains := 0
		if p, ok := byDay[fmtDay(end)]; ok {
			for c, v := range p.Chains {
				gChain.WithLabelValues(a.Slug, c).Set(v)
				nChains++
			}
		}
		gChains.WithLabelValues(a.Slug).Set(float64(nChains))
		healthy := 0.0
		if real, err := parseDay(a.LastDay); err == nil && lastClosed.Sub(real) <= 72*time.Hour {
			healthy = 1
		}
		gHealth.WithLabelValues(a.Slug).Set(healthy)
	}
	for w := range windows {
		gCohort.WithLabelValues(w).Set(totals[w])
		for slug, sums := range perApp {
			if v, ok := sums[w]; ok && totals[w] > 0 {
				gShare.WithLabelValues(slug, w).Set(100 * v / totals[w])
			} else {
				gShare.DeleteLabelValues(slug, w)
			}
		}
	}
	gRefresh.Set(float64(time.Now().Unix()))
}

func writeAtomic(path string, h *History) error {
	b, err := json.Marshal(h)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func utcDay(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func fmtDay(t time.Time) string { return t.UTC().Format("2006-01-02") }

func parseDay(s string) (time.Time, error) {
	return time.Parse("2006-01-02", strings.TrimSpace(s))
}
