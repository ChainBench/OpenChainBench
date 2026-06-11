package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Local HL frontends bench harness (v2).
//
// Reads /mnt/hyperliquid/data/node_fills_by_block/hourly/YYYYMMDD/HH files
// produced by the hl-node running on the same host. Aggregates fills per
// known builder over a rolling 24h window and exposes Prometheus metrics on
// :2113/metrics (loopback). A Caddy reverse proxy fronts :8088 with basic
// auth for external scrape from the OCB Prom on Railway.

type Builder struct {
	Slug      string   `json:"slug"`
	Name      string   `json:"name"`
	Address   string   `json:"address"`
	Addresses []string `json:"addresses,omitempty"`
	ValidFrom string   `json:"valid_from"`
	Notes     string   `json:"notes"`
}

// allAddresses returns every builder address attributed to this entry, lowercased.
// Some frontends (Okto and friends) route through multiple builder addresses;
// the registry can list them under `addresses` while `address` stays as the
// primary for human readability. We always include `address` as the canonical
// entry and append any extras from `addresses` without duplicates.
func (b Builder) allAddresses() []string {
	seen := make(map[string]struct{}, 1+len(b.Addresses))
	out := make([]string, 0, 1+len(b.Addresses))
	add := func(s string) {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" {
			return
		}
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	add(b.Address)
	for _, a := range b.Addresses {
		add(a)
	}
	return out
}

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	var (
		dataDir     = flag.String("data", "/mnt/hyperliquid/data/node_fills_by_block/hourly", "HL node_fills_by_block hourly root")
		buildersF   = flag.String("builders", "builders.json", "builders registry")
		metricsAddr = flag.String("addr", "127.0.0.1:2113", "metrics listen addr")
		windowH     = flag.Int("window-hours", 24, "rolling window length in hours")
		tickEvery   = flag.Duration("tick", 30*time.Second, "aggregate refresh interval")
		usersBackfD = flag.Int("users-backfill-days", 8, "days of fill history to scan once at startup to seed the 7d/30d unique-user sets")
	)
	flag.Parse()

	builders, err := loadBuilders(*buildersF)
	if err != nil {
		log.Fatalf("load builders: %v", err)
	}
	log.Printf("loaded %d builders", len(builders))

	registerMetrics(builders)

	state := newAggState(builders, time.Duration(*windowH)*time.Hour)
	// Hour floor of the oldest file warmup will read. Backfill seeds
	// additive HIP-3 sums only for strictly older files (see AggState).
	state.backfillCutoffSec = time.Now().UTC().
		Add(-time.Duration(*windowH+2) * time.Hour).
		Truncate(time.Hour).Unix()

	if err := state.warmup(*dataDir); err != nil {
		log.Printf("warmup: %v (continuing — values will fill over time)", err)
	}
	state.publish()

	go state.backfillUsers(*dataDir, *usersBackfD)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		t := time.NewTicker(*tickEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := state.tickRefresh(*dataDir); err != nil {
					log.Printf("tickRefresh: %v", err)
				}
				state.publish()
			}
		}
	}()

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	srv := &http.Server{Addr: *metricsAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}

	go func() {
		log.Printf("metrics listening on %s", *metricsAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down")
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

func loadBuilders(p string) ([]Builder, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var bs []Builder
	if err := json.Unmarshal(b, &bs); err != nil {
		return nil, err
	}
	for i := range bs {
		bs[i].Address = strings.ToLower(bs[i].Address)
		for j := range bs[i].Addresses {
			bs[i].Addresses[j] = strings.ToLower(bs[i].Addresses[j])
		}
	}
	return bs, nil
}

type AggState struct {
	mu                     sync.Mutex
	builders               []Builder
	byAddr                 map[string]string
	window                 time.Duration
	fillsByBuilder         map[string][]fill
	lastPxByCoin           map[string]float64
	fileCursors            map[string]int64
	lastTopAssetsByBuilder map[string][]string
	// Per-builder hourly aggregates kept for 30 days. Key: floor(ts to the
	// hour, UTC) in unix seconds. Memory cost: 720 buckets * ~60 builders *
	// 2 floats = ~350 KB total. Used to compute 7d / 30d rolling sums for
	// fees and volume without keeping every fill in memory for 30 days.
	hourlyByBuilder map[string]map[int64]*hourlyBucket
	// Per-builder per-UTC-day unique wallet sets, for the 7d/30d user
	// counts. Day key: floor(ts to the day, UTC) in unix seconds.
	// Uniqueness can't be folded into hourlyBucket floats — it needs the
	// full wallet set per window. Memory: top builders run ~3-4k wallets
	// per day; across the cohort this stays well under 100 MB for 30 days.
	dailyUsersByBuilder map[string]map[int64]map[string]struct{}
	// Set once the one-shot disk backfill has scanned the retention
	// horizon. Until then the 7d/30d user gauges are not published, so a
	// restart never lowballs them off the 26h warmup window alone.
	usersSeeded bool

	// HIP-3 deployer aggregates. A fill belongs to a HIP-3 dex when its
	// coin is namespaced ("xyz:AAPL" → dex "xyz"); the deployerFee field
	// carries the dex operator's cut in USDC. Volumes here are far larger
	// than the builder-code stream (trade.xyz alone clears ~4M fills/24h),
	// so nothing is kept per fill: hourly buckets for sums, hourly wallet
	// and market sets for the exact 24h unions (pruned past 26h), per-day
	// wallet sets for the 7d/30d user counts (seeded by the backfill).
	hip3Hourly        map[string]map[int64]*hip3Bucket
	hip3HourlyUsers   map[string]map[int64]map[string]struct{}
	hip3HourlyMarkets map[string]map[int64]map[string]struct{}
	hip3DailyUsers    map[string]map[int64]map[string]struct{}
	hip3LastFillMs    map[string]int64
	// Hour floor (unix sec) of the oldest file the warmup/tail path owns.
	// The backfill seeds additive hip3 sums ONLY for strictly older files,
	// so overlapping hours are never double counted. Wallet sets are
	// idempotent and merged from both paths.
	backfillCutoffSec int64
}

type hip3Bucket struct {
	feesUSD   float64
	volumeUSD float64
	fills     float64
}

type hourlyBucket struct {
	feesUSD   float64
	volumeUSD float64
}

type fill struct {
	tsMs       int64
	user       string
	coin       string
	notional   float64
	builderFee float64
	crossed    bool
	devBps     float64
	devValid   bool
}

func newAggState(builders []Builder, window time.Duration) *AggState {
	byAddr := make(map[string]string, len(builders))
	for _, b := range builders {
		for _, addr := range b.allAddresses() {
			byAddr[addr] = b.Slug
		}
	}
	return &AggState{
		builders:               builders,
		byAddr:                 byAddr,
		window:                 window,
		fillsByBuilder:         make(map[string][]fill),
		lastPxByCoin:           make(map[string]float64),
		fileCursors:            make(map[string]int64),
		lastTopAssetsByBuilder: make(map[string][]string),
		hourlyByBuilder:        make(map[string]map[int64]*hourlyBucket),
		dailyUsersByBuilder:    make(map[string]map[int64]map[string]struct{}),
		hip3Hourly:             make(map[string]map[int64]*hip3Bucket),
		hip3HourlyUsers:        make(map[string]map[int64]map[string]struct{}),
		hip3HourlyMarkets:      make(map[string]map[int64]map[string]struct{}),
		hip3DailyUsers:         make(map[string]map[int64]map[string]struct{}),
		hip3LastFillMs:         make(map[string]int64),
	}
}

func (a *AggState) publish() {
	a.mu.Lock()
	defer a.mu.Unlock()

	nowMs := time.Now().UnixMilli()
	cutoff := nowMs - a.window.Milliseconds()
	windowMin := a.window.Minutes()

	// Hourly bucket horizons (unix seconds, UTC floor) for 7d and 30d sums.
	// We prune everything older than 30d on each publish — ~720 entries per
	// builder, so the iteration cost is negligible.
	nowSec := nowMs / 1000
	cutoff7d := nowSec - 7*24*3600
	cutoff30d := nowSec - 30*24*3600

	for _, b := range a.builders {
		fills := a.fillsByBuilder[b.Slug]
		var pruned []fill
		var volume, fees float64
		var devSum float64
		var devCount int
		var maxTs int64
		var takerCount int
		assetVol := make(map[string]float64)
		users := make(map[string]struct{})

		for _, f := range fills {
			if f.tsMs < cutoff {
				continue
			}
			pruned = append(pruned, f)
			volume += f.notional
			fees += f.builderFee
			if f.user != "" {
				users[f.user] = struct{}{}
			}
			if f.devValid {
				devSum += f.devBps
				devCount++
			}
			if f.tsMs > maxTs {
				maxTs = f.tsMs
			}
			if f.crossed {
				takerCount++
			}
			if f.coin != "" {
				assetVol[f.coin] += f.notional
			}
		}
		a.fillsByBuilder[b.Slug] = pruned

		hlVolumeUSD24h.WithLabelValues(b.Slug).Set(volume)
		hlFeesUSD24h.WithLabelValues(b.Slug).Set(fees)
		hlUsers24h.WithLabelValues(b.Slug).Set(float64(len(users)))
		hlFillsTotal24h.WithLabelValues(b.Slug).Set(float64(len(pruned)))

		if volume > 0 {
			hlEffectiveFeeBps.WithLabelValues(b.Slug).Set(fees / volume * 10_000)
		} else {
			hlEffectiveFeeBps.WithLabelValues(b.Slug).Set(0)
		}

		if len(users) > 0 {
			hlFeesPerUserUSD.WithLabelValues(b.Slug).Set(fees / float64(len(users)))
		} else {
			hlFeesPerUserUSD.WithLabelValues(b.Slug).Set(0)
		}

		if maxTs > 0 {
			ageSec := float64(nowMs-maxTs) / 1000.0
			hlLastFillAgeSeconds.WithLabelValues(b.Slug).Set(ageSec)
		} else {
			hlLastFillAgeSeconds.WithLabelValues(b.Slug).Set(a.window.Seconds())
		}

		if windowMin > 0 {
			hlFillsPerMin.WithLabelValues(b.Slug).Set(float64(len(pruned)) / windowMin)
		}

		if devCount > 0 {
			hlPriceDeviationBps.WithLabelValues(b.Slug).Set(devSum / float64(devCount))
		} else {
			hlPriceDeviationBps.WithLabelValues(b.Slug).Set(0)
		}

		if len(pruned) > 0 {
			hlTakerPct.WithLabelValues(b.Slug).Set(float64(takerCount) / float64(len(pruned)))
		} else {
			hlTakerPct.WithLabelValues(b.Slug).Set(0)
		}

		a.publishTopAssets(b.Slug, assetVol)

		// 7d / 30d rolling sums from hourly buckets. Prune anything older
		// than 30d while we're iterating.
		buckets := a.hourlyByBuilder[b.Slug]
		var fees7d, fees30d, volume7d, volume30d float64
		for tsHour, bk := range buckets {
			if tsHour < cutoff30d {
				delete(buckets, tsHour)
				continue
			}
			volume30d += bk.volumeUSD
			fees30d += bk.feesUSD
			if tsHour >= cutoff7d {
				volume7d += bk.volumeUSD
				fees7d += bk.feesUSD
			}
		}
		hlVolumeUSD7d.WithLabelValues(b.Slug).Set(volume7d)
		hlVolumeUSD30d.WithLabelValues(b.Slug).Set(volume30d)
		hlFeesUSD7d.WithLabelValues(b.Slug).Set(fees7d)
		hlFeesUSD30d.WithLabelValues(b.Slug).Set(fees30d)

		// 7d/30d unique users from the per-UTC-day wallet sets. Gated on
		// the disk backfill so a fresh process never publishes counts
		// built from the 26h warmup alone. Day sets older than 31 days
		// are pruned in the same pass.
		if a.usersSeeded {
			cutoffDay7 := nowSec - 7*24*3600
			cutoffDayPrune := nowSec - 31*24*3600
			u7 := make(map[string]struct{})
			u30 := make(map[string]struct{})
			days := a.dailyUsersByBuilder[b.Slug]
			for day, set := range days {
				if day < cutoffDayPrune {
					delete(days, day)
					continue
				}
				for u := range set {
					u30[u] = struct{}{}
					if day >= cutoffDay7 {
						u7[u] = struct{}{}
					}
				}
			}
			hlUsers7d.WithLabelValues(b.Slug).Set(float64(len(u7)))
			hlUsers30d.WithLabelValues(b.Slug).Set(float64(len(u30)))
		}
	}

	a.publishHip3Locked(nowMs)
	hlLastTickUnix.Set(float64(time.Now().Unix()))
}

// publishHip3Locked folds the HIP-3 hourly buckets and wallet/market sets
// into the per-dex gauges. Caller must hold a.mu.
func (a *AggState) publishHip3Locked(nowMs int64) {
	nowSec := nowMs / 1000
	cutoff24 := nowSec - 24*3600
	cutoff7d := nowSec - 7*24*3600
	cutoff30d := nowSec - 30*24*3600
	cutoffSets := nowSec - 26*3600

	for dex, hours := range a.hip3Hourly {
		var f24, v24, fl24, f7, v7, f30, v30 float64
		for h, bk := range hours {
			if h < cutoff30d {
				delete(hours, h)
				continue
			}
			f30 += bk.feesUSD
			v30 += bk.volumeUSD
			if h >= cutoff7d {
				f7 += bk.feesUSD
				v7 += bk.volumeUSD
			}
			if h >= cutoff24 {
				f24 += bk.feesUSD
				v24 += bk.volumeUSD
				fl24 += bk.fills
			}
		}

		users24 := make(map[string]struct{})
		for h, set := range a.hip3HourlyUsers[dex] {
			if h < cutoffSets {
				delete(a.hip3HourlyUsers[dex], h)
				continue
			}
			if h < cutoff24 {
				continue
			}
			for u := range set {
				users24[u] = struct{}{}
			}
		}
		markets24 := make(map[string]struct{})
		for h, set := range a.hip3HourlyMarkets[dex] {
			if h < cutoffSets {
				delete(a.hip3HourlyMarkets[dex], h)
				continue
			}
			if h < cutoff24 {
				continue
			}
			for m := range set {
				markets24[m] = struct{}{}
			}
		}

		hip3FeesUSD24h.WithLabelValues(dex).Set(f24)
		hip3FeesUSD7d.WithLabelValues(dex).Set(f7)
		hip3FeesUSD30d.WithLabelValues(dex).Set(f30)
		hip3VolumeUSD24h.WithLabelValues(dex).Set(v24)
		hip3VolumeUSD7d.WithLabelValues(dex).Set(v7)
		hip3VolumeUSD30d.WithLabelValues(dex).Set(v30)
		hip3Fills24h.WithLabelValues(dex).Set(fl24)
		hip3Users24h.WithLabelValues(dex).Set(float64(len(users24)))
		hip3Markets24h.WithLabelValues(dex).Set(float64(len(markets24)))
		if v24 > 0 {
			hip3EffectiveFeeBps.WithLabelValues(dex).Set(f24 / v24 * 10_000)
		} else {
			hip3EffectiveFeeBps.WithLabelValues(dex).Set(0)
		}
		if last := a.hip3LastFillMs[dex]; last > 0 {
			hip3LastFillAgeSeconds.WithLabelValues(dex).Set(float64(nowMs-last) / 1000.0)
		}

		if a.usersSeeded {
			cutoffDay7 := nowSec - 7*24*3600
			cutoffDayPrune := nowSec - 31*24*3600
			u7 := make(map[string]struct{})
			u30 := make(map[string]struct{})
			for day, set := range a.hip3DailyUsers[dex] {
				if day < cutoffDayPrune {
					delete(a.hip3DailyUsers[dex], day)
					continue
				}
				for u := range set {
					u30[u] = struct{}{}
					if day >= cutoffDay7 {
						u7[u] = struct{}{}
					}
				}
			}
			hip3Users7d.WithLabelValues(dex).Set(float64(len(u7)))
			hip3Users30d.WithLabelValues(dex).Set(float64(len(u30)))
		}
	}
}

// backfillUsers streams the node's hourly fill files across the retention
// horizon ONCE at startup and seeds the per-day wallet sets. Runs in a
// goroutine after warmup; the 24h metrics are live the whole time. The
// scan only JSON-parses lines that contain a builder attribution (~5% of
// fills), so a full 8-day horizon (~35 GB) takes single-digit minutes of
// sequential IO without starving the co-located node.
func (a *AggState) backfillUsers(root string, days int) {
	start := time.Now()
	now := time.Now().UTC()
	type hourFile struct {
		path   string
		hourTs int64
	}
	var files []hourFile
	for i := days * 24; i >= 0; i-- {
		t := now.Add(-time.Duration(i) * time.Hour)
		p := filepath.Join(root, t.Format("20060102"), fmt.Sprintf("%d", t.Hour()))
		if _, err := os.Stat(p); err == nil {
			files = append(files, hourFile{p, t.Truncate(time.Hour).Unix()})
		}
	}
	for _, f := range files {
		if err := a.scanHistoryFile(f.path, f.hourTs); err != nil {
			log.Printf("history backfill %s: %v", f.path, err)
		}
	}
	a.mu.Lock()
	a.usersSeeded = true
	a.mu.Unlock()
	log.Printf("users backfill done: %d hourly files in %s", len(files), time.Since(start))
}

func (a *AggState) publishTopAssets(slug string, assetVol map[string]float64) {
	type kv struct {
		asset string
		vol   float64
	}
	pairs := make([]kv, 0, len(assetVol))
	for k, v := range assetVol {
		if v > 0 {
			pairs = append(pairs, kv{k, v})
		}
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].vol > pairs[j].vol })
	if len(pairs) > 3 {
		pairs = pairs[:3]
	}

	prev := a.lastTopAssetsByBuilder[slug]
	newAssets := make(map[string]bool, len(pairs))
	for _, p := range pairs {
		newAssets[p.asset] = true
	}
	for i, old := range prev {
		if !newAssets[old] {
			hlAssetVolumeTopUSD.DeleteLabelValues(slug, old, strconv.Itoa(i+1))
		}
	}

	current := make([]string, len(pairs))
	for i, p := range pairs {
		hlAssetVolumeTopUSD.WithLabelValues(slug, p.asset, strconv.Itoa(i+1)).Set(p.vol)
		current[i] = p.asset
	}
	a.lastTopAssetsByBuilder[slug] = current
}

func (a *AggState) listHourFiles(root string) ([]string, error) {
	now := time.Now().UTC()
	hours := int(a.window.Hours()) + 2
	var out []string
	for i := hours; i >= 0; i-- {
		t := now.Add(-time.Duration(i) * time.Hour)
		p := filepath.Join(root, t.Format("20060102"), fmt.Sprintf("%d", t.Hour()))
		if _, err := os.Stat(p); err == nil {
			out = append(out, p)
		}
	}
	return out, nil
}

func (a *AggState) warmup(root string) error {
	files, err := a.listHourFiles(root)
	if err != nil {
		return err
	}
	for _, f := range files {
		if err := a.consumeFile(f, true); err != nil {
			log.Printf("warmup %s: %v", f, err)
		}
	}
	log.Printf("warmup done; rolling window pre-loaded across %d hourly files", len(files))
	return nil
}

func (a *AggState) tickRefresh(root string) error {
	files, err := a.listHourFiles(root)
	if err != nil {
		return err
	}
	for _, f := range files {
		if err := a.consumeFile(f, false); err != nil {
			log.Printf("consumeFile %s: %v", f, err)
		}
	}
	return nil
}
