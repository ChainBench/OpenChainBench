package main

import (
	"context"
	"log"
	"math"
	"os"
	"sort"
	"sync"
	"time"
)

const daySec = 86400

// Aggregator owns the feed mirror, the parsed-day cache and the publish
// step. One instance per process.
type Aggregator struct {
	builders     []Builder
	addrs        []string          // every registry address, lowercased
	slugByAddr   map[string]string // address -> registry slug
	mirror       *Mirror
	state        *State
	windowDays   int       // days behind the feed day the 30d gauges cover
	graceDays    int       // a 403 on a day this recent is re-requested every pass
	minPublished int       // files needed on a day before it counts as published
	workers      int       // concurrent feed downloads
	ledgerFrom   time.Time // oldest day the ledger backfill walks to
	settle       time.Duration

	mu              sync.Mutex
	cache           map[string]map[string]*daySummary // addr -> day -> parsed CSV
	dataDay         time.Time                         // zero until a feed day is eligible
	initialSyncDone bool
	lastSyncOK      bool // the last feed pass had no transport failures
	ledgerDone      bool
	prevCoins       map[string][]string
	prevDataDay     string
	// Per-builder JSON views served on /daily-series and /top-users,
	// rebuilt on every publish.
	snapshots map[string]*builderSnapshot
}

type topUser struct {
	Address string  `json:"address"`
	Volume  float64 `json:"volume_30d"`
	Pnl     float64 `json:"pnl_30d"`
	Fees    float64 `json:"fees_30d"`
	Fills   int     `json:"fills_30d"`
}

type dailyPoint struct {
	Date    string  `json:"date"`
	DayUnix int64   `json:"day_unix"`
	Fees    float64 `json:"fees_usd"`
	Volume  float64 `json:"volume_usd"`
	Users   int     `json:"users"`
}

type builderSnapshot struct {
	asOf       int64
	totalUsers int
	top        []topUser
	points     []dailyPoint
}

const topUsersCap = 500

func newAggregator(builders []Builder, mirror *Mirror, state *State) *Aggregator {
	a := &Aggregator{
		builders:   builders,
		slugByAddr: make(map[string]string),
		mirror:     mirror,
		state:      state,
		cache:      make(map[string]map[string]*daySummary),
		prevCoins:  make(map[string][]string),
		snapshots:  make(map[string]*builderSnapshot),
	}
	for _, b := range builders {
		for _, addr := range b.allAddresses() {
			a.slugByAddr[addr] = b.Slug
			a.addrs = append(a.addrs, addr)
		}
	}
	if state.DataDay != "" {
		if d, err := time.Parse(dayFormat, state.DataDay); err == nil {
			a.dataDay = d.UTC()
		}
	}
	return a
}

func utcDay(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func dayKey(t time.Time) string { return utcDay(t).Format(dayFormat) }

// fetchRange is the span of days the mirror keeps: enough for a 30-day
// window ending on a feed day that may itself lag by graceDays.
func (a *Aggregator) fetchRange(now time.Time) (from, to time.Time) {
	to = utcDay(now).AddDate(0, 0, -1)
	from = to.AddDate(0, 0, -(a.windowDays - 1 + a.graceDays))
	return from, to
}

type fetchJob struct {
	addr string
	day  time.Time
}

// runJobs downloads every job with the configured concurrency. Returns the
// number of transport-level failures (absent files are not failures).
func (a *Aggregator) runJobs(ctx context.Context, jobs []fetchJob) int {
	if len(jobs) == 0 {
		return 0
	}
	ch := make(chan fetchJob)
	var wg sync.WaitGroup
	var failures int64
	var fmu sync.Mutex
	workers := a.workers
	if workers <= 0 {
		workers = 4
	}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range ch {
				if ctx.Err() != nil {
					return
				}
				err := a.mirror.fetch(ctx, j.addr, j.day)
				if err != nil && err != errFeedAbsent {
					fmu.Lock()
					failures++
					fmu.Unlock()
					log.Printf("feed %s %s: %v", j.addr, j.day.Format(dayFormat), err)
				}
				time.Sleep(50 * time.Millisecond)
			}
		}()
	}
	for _, j := range jobs {
		select {
		case <-ctx.Done():
			close(ch)
			wg.Wait()
			return int(failures)
		case ch <- j:
		}
	}
	close(ch)
	wg.Wait()
	return int(failures)
}

// syncWindow brings the mirror up to date for the fetch range, then
// re-evaluates the feed day. Blocking; called from the poll loop.
func (a *Aggregator) syncWindow(ctx context.Context) {
	now := time.Now().UTC()
	from, to := a.fetchRange(now)
	var jobs []fetchJob
	for d := to; !d.Before(from); d = d.AddDate(0, 0, -1) {
		recent := d.After(to.AddDate(0, 0, -a.graceDays))
		for _, addr := range a.addrs {
			if a.mirror.present(addr, d) {
				continue
			}
			// A 403 on an old day is final (no fills). On a recent day every
			// missing file is re-requested on every pass, so by the time the
			// settle check passes (newest CDN upload older than `settle`) no
			// file that exists on the CDN can still be missing from the mirror.
			if !recent && !a.mirror.absentSince(addr, d).IsZero() {
				continue
			}
			jobs = append(jobs, fetchJob{addr: addr, day: d})
		}
	}
	start := time.Now()
	failures := a.runJobs(ctx, jobs)
	log.Printf("feed sync: %d requests, %d failures, %s", len(jobs), failures, time.Since(start).Round(time.Second))

	a.mu.Lock()
	a.initialSyncDone = true
	a.lastSyncOK = failures == 0
	a.mu.Unlock()
	a.chooseDataDay(now)
	a.mirror.prune(a.windowDays + a.graceDays + 2)
}

// chooseDataDay picks the newest day in the grace span that has at least
// minPublished files whose newest CDN upload (file mtime = Last-Modified)
// is older than `settle`, so a batch still being uploaded is not read
// half-way. The choice only ever moves forward.
func (a *Aggregator) chooseDataDay(now time.Time) {
	_, to := a.fetchRange(now)
	hlMirrorFiles.Set(float64(a.countMirror(now)))
	// A pass with a transport failure may have left a published file
	// unfetched; the settle rule only holds when every request answered,
	// so the day never advances on such a pass.
	a.mu.Lock()
	clean := a.lastSyncOK
	a.mu.Unlock()
	if !clean {
		return
	}
	// Compare against the clock now, not the sync start that preceded this
	// call.
	now = time.Now().UTC()
	for d := to; d.After(to.AddDate(0, 0, -a.graceDays-1)); d = d.AddDate(0, 0, -1) {
		count := 0
		var newest time.Time
		for _, addr := range a.addrs {
			st, err := os.Stat(a.mirror.filePath(addr, d))
			if err != nil || st.Size() == 0 {
				continue
			}
			count++
			if st.ModTime().After(newest) {
				newest = st.ModTime()
			}
		}
		if count < a.minPublished || now.Sub(newest) < a.settle {
			continue
		}
		a.mu.Lock()
		if d.After(a.dataDay) {
			a.dataDay = d
			log.Printf("feed day advanced to %s (%d files)", d.Format(dayFormat), count)
		}
		a.mu.Unlock()
		break
	}
}

func (a *Aggregator) countMirror(now time.Time) int {
	from, to := a.fetchRange(now)
	n := 0
	for d := to; !d.Before(from); d = d.AddDate(0, 0, -1) {
		for _, addr := range a.addrs {
			if a.mirror.present(addr, d) {
				n++
			}
		}
	}
	return n
}

// summary returns the parsed CSV for (addr, day), reading the mirror on
// first use. nil when the mirror has no file.
func (a *Aggregator) summary(addr string, day time.Time) *daySummary {
	key := dayKey(day)
	a.mu.Lock()
	if m, ok := a.cache[addr]; ok {
		if s, ok := m[key]; ok {
			a.mu.Unlock()
			return s
		}
	}
	a.mu.Unlock()
	if !a.mirror.present(addr, day) {
		return nil
	}
	s, err := a.mirror.parseFile(addr, day)
	if err != nil {
		// A truncated or corrupt download must not be published or cached
		// as a partial day: drop the file so the next sync fetches it again.
		log.Printf("parse %s %s: %v (file removed, will refetch while the day is recent)", addr, key, err)
		_ = os.Remove(a.mirror.filePath(addr, day))
		_ = a.mirror.markAbsent(addr, day)
		return nil
	}
	a.mu.Lock()
	m, ok := a.cache[addr]
	if !ok {
		m = make(map[string]*daySummary)
		a.cache[addr] = m
	}
	m[key] = s
	a.mu.Unlock()
	return s
}

// evictCache drops parsed days outside the fetch range.
func (a *Aggregator) evictCache(now time.Time) {
	from, _ := a.fetchRange(now)
	cutoff := dayKey(from)
	a.mu.Lock()
	defer a.mu.Unlock()
	for addr, m := range a.cache {
		for k := range m {
			if k < cutoff {
				delete(m, k)
			}
		}
		if len(m) == 0 {
			delete(a.cache, addr)
		}
	}
}

// merged folds every address of a builder for one day into one summary.
// nil when no address has a file that day.
func (a *Aggregator) merged(b Builder, day time.Time) *daySummary {
	var out *daySummary
	for _, addr := range b.allAddresses() {
		s := a.summary(addr, day)
		if s == nil {
			continue
		}
		if out == nil {
			out = newDaySummary()
		}
		out.fees += s.fees
		out.vol += s.vol
		out.fills += s.fills
		out.taker += s.taker
		if s.lastFillS > out.lastFillS {
			out.lastFillS = s.lastFillS
		}
		for c, v := range s.coinVol {
			out.coinVol[c] += v
		}
		for u, ua := range s.users {
			cur := out.users[u]
			cur.vol += ua.vol
			cur.pnl += ua.pnl
			cur.fee += ua.fee
			cur.fills += ua.fills
			out.users[u] = cur
		}
	}
	return out
}

type builderWindow struct {
	day      *daySummary
	dayKnown bool // D has a file, or every address answered 403
	fees7    float64
	fees30   float64
	vol7     float64
	vol30    float64
	users7   int
	users30  int
	users30m map[string]userAgg
}

// publish recomputes every builder gauge for the current feed day.
func (a *Aggregator) publish() {
	a.mu.Lock()
	D := a.dataDay
	synced := a.initialSyncDone
	syncOK := a.lastSyncOK
	ledgerDone := a.ledgerDone
	a.mu.Unlock()
	if D.IsZero() || !synced {
		return
	}
	start := time.Now()
	now := time.Now().UTC()
	dKey := D.Format(dayFormat)
	// Every day from the fetch-range start is on disk, so the ledger rows
	// for [mirrorFrom, D] are rewritten from the mirror on each publish and
	// count as complete; older days need the one-off backfill.
	mirrorFrom, _ := a.fetchRange(now)
	windowStart := D.AddDate(0, 0, -(a.windowDays - 1))
	for _, b := range a.builders {
		for d := mirrorFrom; d.Before(windowStart); d = d.AddDate(0, 0, 1) {
			a.writeLedgerDay(b, d)
		}
	}

	// day key -> the latest fill second seen across every builder. Used to
	// tell a short day from a truncated feed; see publishCoverage.
	cohortLastFill := map[string]int64{}

	rows := make(map[string]builderWindow, len(a.builders))
	var cohortVol float64
	for _, b := range a.builders {
		w := builderWindow{users30m: make(map[string]userAgg)}
		u7 := make(map[string]struct{})
		for i := 0; i < a.windowDays; i++ {
			d := D.AddDate(0, 0, -i)
			if d.Before(mirrorFrom) {
				// Files for this day are gone (the feed day lags the fetch
				// range); the ledger row written while it was mirrored is
				// the source. Wallet sets are not recoverable from it.
				t := a.state.ledgerFor(b.Slug)[dayKey(d)]
				w.fees30 += t.Fees
				w.vol30 += t.Vol
				if i < 7 {
					w.fees7 += t.Fees
					w.vol7 += t.Vol
				}
				continue
			}
			s := a.merged(b, d)
			if s != nil && s.lastFillS > cohortLastFill[dayKey(d)] {
				// Furthest fill any builder saw that day. One builder going
				// quiet in the evening proves nothing; the whole cohort going
				// quiet at the same minute is the feed being cut short.
				cohortLastFill[dayKey(d)] = s.lastFillS
			}
			if i == 0 {
				w.day = s
				w.dayKnown = s != nil || a.allAbsent(b, d)
			}
			a.writeLedgerDay(b, d)
			if s == nil {
				continue
			}
			w.fees30 += s.fees
			w.vol30 += s.vol
			if i < 7 {
				w.fees7 += s.fees
				w.vol7 += s.vol
			}
			for u, ua := range s.users {
				cur := w.users30m[u]
				cur.vol += ua.vol
				cur.pnl += ua.pnl
				cur.fee += ua.fee
				cur.fills += ua.fills
				w.users30m[u] = cur
				if i < 7 {
					u7[u] = struct{}{}
				}
			}
		}
		w.users7 = len(u7)
		w.users30 = len(w.users30m)
		rows[b.Slug] = w
		if w.day != nil {
			cohortVol += w.day.vol
		}
	}

	for _, b := range a.builders {
		w := rows[b.Slug]
		if !w.dayKnown {
			// Day D has no file and not every address answered 403: a
			// download failed. Keep the previous gauge values rather than
			// publish $0 for a builder that traded.
			continue
		}
		var fees, vol float64
		var fills, taker, users int
		if w.day != nil {
			fees, vol, fills, taker, users = w.day.fees, w.day.vol, w.day.fills, w.day.taker, len(w.day.users)
		}
		hlFeesUSD24h.WithLabelValues(b.Slug).Set(fees)
		hlVolumeUSD24h.WithLabelValues(b.Slug).Set(vol)
		hlFills24h.WithLabelValues(b.Slug).Set(float64(fills))
		hlUsers24h.WithLabelValues(b.Slug).Set(float64(users))
		hlFeesUSD7d.WithLabelValues(b.Slug).Set(w.fees7)
		hlFeesUSD30d.WithLabelValues(b.Slug).Set(w.fees30)
		hlVolumeUSD7d.WithLabelValues(b.Slug).Set(w.vol7)
		hlVolumeUSD30d.WithLabelValues(b.Slug).Set(w.vol30)
		hlUsers7d.WithLabelValues(b.Slug).Set(float64(w.users7))
		hlUsers30d.WithLabelValues(b.Slug).Set(float64(w.users30))
		if vol > 0 {
			hlEffFeeBps.WithLabelValues(b.Slug).Set(fees / vol * 10_000)
		} else {
			hlEffFeeBps.WithLabelValues(b.Slug).Set(0)
		}
		if users > 0 {
			hlFeesPerUser.WithLabelValues(b.Slug).Set(fees / float64(users))
		} else {
			hlFeesPerUser.WithLabelValues(b.Slug).Set(0)
		}
		if fills > 0 {
			hlTakerPct.WithLabelValues(b.Slug).Set(float64(taker) / float64(fills))
		} else {
			hlTakerPct.WithLabelValues(b.Slug).Set(0)
		}
		if cohortVol > 0 {
			hlCohortShare.WithLabelValues(b.Slug).Set(vol / cohortVol)
		} else {
			hlCohortShare.WithLabelValues(b.Slug).Set(0)
		}
		a.publishCoinShare(b.Slug, w.day)
		a.publishPercentiles(b.Slug, w.users30m, w.vol30)

		ledger := a.state.ledgerFor(b.Slug)
		a.publishDeltas(b.Slug, ledger, D, mirrorFrom)
		a.buildSnapshot(b.Slug, D, ledger, w.users30m)
	}

	hlDataDay.Set(float64(D.Unix()))
	hlDataDayEnd.Set(float64(D.Unix() + daySec))
	short := a.publishCoverage(D, windowStart, cohortLastFill)

	// Second pass: the biggest day needs to know which days were cut short,
	// and cohortLastFill is only complete once every builder has been walked.
	if ledgerDone {
		for _, b := range a.builders {
			a.publishLedgerStats(b.Slug, a.state.ledgerFor(b.Slug), short)
		}
	}
	// Liveness means "the feed was reachable and the gauges were rebuilt",
	// not just that the process is up: a pass with transport failures
	// leaves the tick alone so the success query goes false after 2 h.
	if syncOK {
		hlLastTickUnix.Set(float64(now.Unix()))
	}
	if ledgerDone {
		hlLedgerComplete.Set(1)
	} else {
		hlLedgerComplete.Set(0)
	}
	a.state.setDataDay(dKey)
	if err := a.state.save(); err != nil {
		log.Printf("state save: %v", err)
	}
	a.evictCache(now)
	if dKey != a.prevDataDay {
		log.Printf("published feed day %s for %d builders in %s (cohort volume $%.0f)", dKey, len(a.builders), time.Since(start).Round(time.Millisecond), cohortVol)
		a.prevDataDay = dKey
	}
}

// publishCoinShare emits the top 15 coins by notional plus "other" and
// deletes label values that dropped out of the top list.
func (a *Aggregator) publishCoinShare(slug string, day *daySummary) {
	type kv struct {
		coin string
		vol  float64
	}
	var pairs []kv
	var total float64
	if day != nil {
		for c, v := range day.coinVol {
			if v > 0 {
				pairs = append(pairs, kv{c, v})
				total += v
			}
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].vol != pairs[j].vol {
			return pairs[i].vol > pairs[j].vol
		}
		return pairs[i].coin < pairs[j].coin
	})
	var other float64
	if len(pairs) > 15 {
		for _, p := range pairs[15:] {
			other += p.vol
		}
		pairs = pairs[:15]
	}
	current := make([]string, 0, len(pairs)+1)
	keep := make(map[string]bool, len(pairs)+1)
	if total > 0 {
		for _, p := range pairs {
			hlCoinShare.WithLabelValues(slug, p.coin).Set(p.vol / total)
			current = append(current, p.coin)
			keep[p.coin] = true
		}
		if other > 0 {
			hlCoinShare.WithLabelValues(slug, "other").Set(other / total)
			current = append(current, "other")
			keep["other"] = true
		}
	}
	a.mu.Lock()
	prev := a.prevCoins[slug]
	a.prevCoins[slug] = current
	a.mu.Unlock()
	for _, c := range prev {
		if !keep[c] {
			hlCoinShare.DeleteLabelValues(slug, c)
		}
	}
}

var percentileBuckets = []struct {
	name string
	upto float64 // cumulative share of the wallet count, ranked by volume
}{
	{"top1", 0.01}, {"p1_5", 0.05}, {"p5_10", 0.10}, {"p10_25", 0.25}, {"p25_50", 0.50}, {"rest", 1.0},
}

// publishPercentiles splits the 30-day notional by wallet rank bucket and
// emits the share of 30-day wallets with positive realized PnL.
func (a *Aggregator) publishPercentiles(slug string, users map[string]userAgg, vol30 float64) {
	n := len(users)
	if n == 0 || vol30 <= 0 {
		for _, bk := range percentileBuckets {
			hlPercentile.WithLabelValues(slug, bk.name).Set(0)
		}
		hlProfitable.WithLabelValues(slug).Set(0)
		return
	}
	vols := make([]float64, 0, n)
	profitable := 0
	for _, ua := range users {
		vols = append(vols, ua.vol)
		if ua.pnl > 0 {
			profitable++
		}
	}
	sort.Sort(sort.Reverse(sort.Float64Slice(vols)))
	idx := 0
	for _, bk := range percentileBuckets {
		end := int(math.Ceil(bk.upto * float64(n)))
		if end > n {
			end = n
		}
		var sum float64
		for ; idx < end; idx++ {
			sum += vols[idx]
		}
		hlPercentile.WithLabelValues(slug, bk.name).Set(sum / vol30)
	}
	hlProfitable.WithLabelValues(slug).Set(float64(profitable) / float64(n))
}

// rangeSum adds the ledger fees over [from, to] and reports whether every
// day in the range is known: on or after mirrorFrom (rewritten from the
// mirror on every publish) or marked complete by the ledger backfill.
func (a *Aggregator) rangeSum(ledger map[string]dayTotals, from, to, mirrorFrom time.Time) (float64, bool) {
	var sum float64
	complete := true
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		k := dayKey(d)
		if t, ok := ledger[k]; ok {
			sum += t.Fees
		}
		if d.Before(mirrorFrom) && !a.state.isComplete(k) {
			complete = false
		}
	}
	return sum, complete
}

func (a *Aggregator) publishDeltas(slug string, ledger map[string]dayTotals, D, mirrorFrom time.Time) {
	set := func(window string, curFrom, curTo, prevFrom, prevTo time.Time) {
		cur, _ := a.rangeSum(ledger, curFrom, curTo, mirrorFrom)
		prev, ok := a.rangeSum(ledger, prevFrom, prevTo, mirrorFrom)
		if !ok {
			hlRevenueDelta.DeleteLabelValues(slug, window)
			return
		}
		if prev <= 0 {
			hlRevenueDelta.WithLabelValues(slug, window).Set(0)
			return
		}
		hlRevenueDelta.WithLabelValues(slug, window).Set((cur - prev) / prev)
	}
	set("24h", D, D, D.AddDate(0, 0, -1), D.AddDate(0, 0, -1))
	set("7d", D.AddDate(0, 0, -6), D, D.AddDate(0, 0, -13), D.AddDate(0, 0, -7))
	set("30d", D.AddDate(0, 0, -29), D, D.AddDate(0, 0, -59), D.AddDate(0, 0, -30))
}

var milestoneThresholds = []struct {
	label string
	usd   float64
}{{"10k", 10_000}, {"100k", 100_000}, {"1m", 1_000_000}}

// publishLedgerStats emits the biggest day and the revenue milestones from
// the complete ledger.
//
// `short` is the set of day keys the feed published cut short. Those days are
// skipped when picking the biggest day, and only there. A sum over the window
// that includes a half day understates the window, which the coverage gauges
// disclose; a *maximum* over days of unequal length answers a different
// question than the one asked. Measured on fomo 2026-10-07, the biggest day
// came out as 21 September purely because 21 September is one of twelve days
// in the window the feed carried to 23:59, while the genuinely larger days
// after it were cut at 12:00 and summed to less than half their size. Ranking
// coverage and calling it activity is worse than publishing a smaller number,
// so the figure is the biggest day the feed carried *whole* and the site
// labels it that way.
func (a *Aggregator) publishLedgerStats(slug string, ledger map[string]dayTotals, short map[string]bool) {
	days := ledgerDaysSorted(ledger)
	var bestFees float64
	var bestDay string
	var first string
	var cum float64
	hit := make(map[string]string, len(milestoneThresholds))
	for _, d := range days {
		t := ledger[d]
		if t.Fills > 0 && first == "" {
			first = d
		}
		if t.Fees > bestFees && !short[d] {
			bestFees = t.Fees
			bestDay = d
		}
		cum += t.Fees
		for _, m := range milestoneThresholds {
			if _, done := hit[m.label]; !done && cum >= m.usd {
				hit[m.label] = d
			}
		}
	}
	if bestDay != "" {
		bd, _ := time.Parse(dayFormat, bestDay)
		hlBiggestDay.WithLabelValues(slug).Set(bestFees)
		hlBiggestDayAt.WithLabelValues(slug).Set(float64(bd.Unix()))
	} else {
		hlBiggestDay.WithLabelValues(slug).Set(0)
		hlBiggestDayAt.WithLabelValues(slug).Set(0)
	}
	for _, m := range milestoneThresholds {
		v := -1.0
		if d, ok := hit[m.label]; ok && first != "" {
			t0, _ := time.Parse(dayFormat, first)
			t1, _ := time.Parse(dayFormat, d)
			v = math.Round(t1.Sub(t0).Hours() / 24)
		}
		hlMilestone.WithLabelValues(slug, m.label).Set(v)
	}
}

// backfillLedger fetches every day between ledgerFrom and the mirror window
// that is not yet marked complete, one day at a time, and folds the totals
// into the ledger. Files are deleted after parsing. Safe to call repeatedly;
// it returns once every day is complete or the context ends.
func (a *Aggregator) backfillLedger(ctx context.Context) {
	now := time.Now().UTC()
	from, _ := a.fetchRange(now)
	var pending []time.Time
	for d := from.AddDate(0, 0, -1); !d.Before(a.ledgerFrom); d = d.AddDate(0, 0, -1) {
		if !a.state.isComplete(dayKey(d)) {
			pending = append(pending, d)
		}
	}
	if len(pending) == 0 {
		a.mu.Lock()
		a.ledgerDone = true
		a.mu.Unlock()
		return
	}
	log.Printf("ledger backfill: %d days pending back to %s", len(pending), a.ledgerFrom.Format(dayFormat))
	for _, d := range pending {
		if ctx.Err() != nil {
			return
		}
		var jobs []fetchJob
		for _, addr := range a.addrs {
			if a.mirror.present(addr, d) || !a.mirror.absentSince(addr, d).IsZero() {
				continue
			}
			jobs = append(jobs, fetchJob{addr: addr, day: d})
		}
		failures := a.runJobs(ctx, jobs)
		if failures > 0 || ctx.Err() != nil {
			log.Printf("ledger backfill %s: %d failures, will retry", d.Format(dayFormat), failures)
			continue
		}
		for _, b := range a.builders {
			s := a.merged(b, d)
			if s == nil {
				a.state.setLedger(b.Slug, dayKey(d), dayTotals{})
				continue
			}
			a.state.setLedger(b.Slug, dayKey(d), dayTotals{Fees: s.fees, Vol: s.vol, Fills: s.fills, Users: len(s.users)})
		}
		a.mu.Lock()
		for _, addr := range a.addrs {
			if m, ok := a.cache[addr]; ok {
				delete(m, dayKey(d))
			}
		}
		a.mu.Unlock()
		a.state.markComplete(dayKey(d))
		for _, addr := range a.addrs {
			_ = os.Remove(a.mirror.filePath(addr, d))
			_ = os.Remove(a.mirror.absentPath(addr, d))
		}
		if err := a.state.save(); err != nil {
			log.Printf("state save: %v", err)
		}
	}
	remaining := 0
	for _, d := range pending {
		if !a.state.isComplete(dayKey(d)) {
			remaining++
		}
	}
	if remaining == 0 {
		a.mu.Lock()
		a.ledgerDone = true
		a.mu.Unlock()
		log.Printf("ledger backfill complete")
	}
}

// buildSnapshot refreshes the JSON views for one builder: the last 30
// ledger days ending on the feed day and the top wallets by 30-day notional.
func (a *Aggregator) buildSnapshot(slug string, D time.Time, ledger map[string]dayTotals, users map[string]userAgg) {
	points := make([]dailyPoint, 0, a.windowDays)
	for i := a.windowDays - 1; i >= 0; i-- {
		d := D.AddDate(0, 0, -i)
		t := ledger[dayKey(d)]
		points = append(points, dailyPoint{
			Date:    d.Format("2006-01-02"),
			DayUnix: d.Unix(),
			Fees:    t.Fees,
			Volume:  t.Vol,
			Users:   t.Users,
		})
	}
	top := make([]topUser, 0, len(users))
	for addr, ua := range users {
		top = append(top, topUser{Address: addr, Volume: ua.vol, Pnl: ua.pnl, Fees: ua.fee, Fills: ua.fills})
	}
	sort.Slice(top, func(i, j int) bool {
		if top[i].Volume != top[j].Volume {
			return top[i].Volume > top[j].Volume
		}
		return top[i].Address < top[j].Address
	})
	if len(top) > topUsersCap {
		top = top[:topUsersCap]
	}
	a.mu.Lock()
	a.snapshots[slug] = &builderSnapshot{asOf: D.Unix() + daySec, totalUsers: len(users), top: top, points: points}
	a.mu.Unlock()
}

// snapshot returns the JSON view for a builder, nil when unknown or not
// yet published.
func (a *Aggregator) snapshot(slug string) *builderSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.snapshots[slug]
}

// allAbsent reports whether every address of the builder has a 403 marker
// for the day: the only case where "no file" means "no fills".
func (a *Aggregator) allAbsent(b Builder, day time.Time) bool {
	for _, addr := range b.allAddresses() {
		if a.mirror.present(addr, day) {
			return false
		}
		if a.mirror.absentSince(addr, day).IsZero() {
			return false
		}
	}
	return true
}

// writeLedgerDay stores the builder's totals for a mirrored day. A day with
// no file is written as zero only when every address answered 403;
// otherwise the existing row (or none) stands until the file arrives.
func (a *Aggregator) writeLedgerDay(b Builder, d time.Time) {
	if s := a.merged(b, d); s != nil {
		a.state.setLedger(b.Slug, dayKey(d), dayTotals{Fees: s.fees, Vol: s.vol, Fills: s.fills, Users: len(s.users)})
		return
	}
	if a.allAbsent(b, d) {
		a.state.setLedger(b.Slug, dayKey(d), dayTotals{})
	}
}

// dayCoverageHours is how far into a UTC day the cohort's furthest fill
// reached. A complete day lands within minutes of 24; anything materially
// short means the published file stops before the day does.
func dayCoverageHours(day time.Time, lastFillS int64) float64 {
	if lastFillS <= 0 {
		return 0
	}
	h := float64(lastFillS-day.Unix()) / 3600
	switch {
	case h < 0:
		return 0
	case h > 24:
		return 24
	}
	return h
}

// coverageCompleteHours is the point past which a day counts as whole.
//
// Hyperliquid's per-builder export cuts days off at roughly 12:10 UTC, and it
// does so intermittently rather than from one clean break: measured across
// the archive on 2026-10-07, 15, 16 and 18 September were already short while
// 17, 19, 20 and 21 September ran to 23:5x, and 3 October ran to 23:58:44 in
// the middle of an otherwise unbroken run of short days from 22 September.
// Seventeen of the thirty days ending 6 October were short. The file is
// stable across re-downloads, so this is the published artefact and not a
// partial fetch.
//
// Summing such a day beside a whole one understates it by about half and says
// nothing, which is the shape of error this harness exists to avoid. 23
// leaves an hour of slack for a genuinely quiet late evening across the
// entire cohort, which has never happened in the mirror.
//
// Note the threshold is applied to the cohort's furthest fill, never to one
// builder's. A single builder's file ending at midday usually means that
// builder stopped trading: fomo's own file ends at 12:xx on 8 September, a
// day the cohort carried to 23:59:51.
const coverageCompleteHours = 23

// publishCoverage reports how much of each day the feed actually carried and
// returns the set of day keys it proved short.
//
// The window figures stay published either way: the fix for a truncated
// upstream is to say so, not to drop the day and let the window silently
// shorten. The returned set exists for the one figure where a short day is not
// an understatement but a wrong answer, the biggest day on record, which
// compares days against each other rather than summing them.
func (a *Aggregator) publishCoverage(D, windowStart time.Time, lastFill map[string]int64) map[string]bool {
	// Record every day we could measure this pass, so the count below can
	// still see it once the fetch range moves past it and the files are gone.
	for k, ls := range lastFill {
		d, err := time.Parse(dayFormat, k)
		if err != nil {
			continue
		}
		a.state.setDayCoverage(k, dayCoverageHours(d, ls))
	}

	cov := dayCoverageHours(D, lastFill[dayKey(D)])
	hlDayCoverageHours.Set(cov)
	if cov < coverageCompleteHours {
		hlDayTruncated.Set(1)
	} else {
		hlDayTruncated.Set(0)
	}

	short := map[string]bool{}
	measured := 0
	for d := windowStart; !d.After(D); d = d.AddDate(0, 0, 1) {
		k := dayKey(d)
		h, ok := a.state.dayCoverage(k)
		if !ok {
			// Never measured: the harness started after this day left the
			// mirror window. Not counted either way, and the examined count
			// says so rather than letting the ratio imply a clean day.
			continue
		}
		measured++
		if h < coverageCompleteHours {
			short[k] = true
		}
	}
	hlTruncatedDaysWindow.Set(float64(len(short)))
	hlCoverageDaysMeasured.Set(float64(measured))
	a.state.pruneDayCoverage(dayKey(windowStart.AddDate(0, 0, -30)))
	return short
}
