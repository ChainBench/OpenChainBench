package main

// window.go: the 24h sliding window of liquidation notionals, the dedup
// SeenSet pruned alongside it, and the 24h sample window that averages open
// interest.
//
// Two kinds of event land in the window and they need different treatment.
//
// An *event* source (an on-chain log, a trade tape row) reports an immutable
// fact once: the same key must never be counted twice, which is what SeenSet
// is for. A *bucket* source (Coinalyze publishes hourly liquidation totals)
// reports a figure that grows while its hour is still open, so re-observing
// the same key carries a larger number that must replace the one already
// stored. Treating a bucket like an event froze every hour at the value it
// had a few minutes after the hour began: Lighter read $887 against a
// $185.6M of daily ETH volume until 2026-09-27 because of it.

import (
	"sort"
	"sync"
	"time"
)

type windowEntry struct {
	key        string
	tsMs       int64
	notional   float64
	collateral float64 // 0 when the source does not expose it
	leverage   float64 // 0 when the source does not expose it
	// hasForfeit says the three quantities below were read, so the entry can
	// carry the forfeited-collateral arithmetic. A returned share of zero is
	// the normal reading on two of the three venues that report it, so the
	// flag is what separates "nothing came back" from "nobody said".
	hasForfeit  bool
	lossPct     float64 // price loss at the close, % of collateral, loss positive
	returnedUSD float64 // margin returned to the trader, USD
	// hasFeeSplit and feeAndCarryUSD hold the part of the forfeit the feed
	// itemises as trading fees and carry rather than as the venue's
	// liquidation penalty. GMX itemises all of it (positionFeeAmount,
	// borrowingFeeAmount, fundingFeeAmount beside liquidationFeeAmount) and
	// Ostium most of it; the Gains event carries no fee word at all, so its
	// forfeit cannot be split from the event and the flag stays false.
	hasFeeSplit    bool
	feeAndCarryUSD float64
}

// SlidingWindow accumulates (key, unix_ms, notional_usd) events and answers
// the rolling sum over its span. All methods are safe for concurrent use.
type SlidingWindow struct {
	mu      sync.Mutex
	entries []windowEntry
	byKey   map[string]int // key -> index into entries, for Upsert
	span    time.Duration
}

// NewSlidingWindow returns a window covering the given span (24h here).
func NewSlidingWindow(span time.Duration) *SlidingWindow {
	return &SlidingWindow{span: span, byKey: make(map[string]int)}
}

// Add appends one event to the window. Callers gate on SeenSet first so the
// same event key is never appended twice.
func (w *SlidingWindow) Add(key string, tsMs int64, notionalUSD float64) {
	w.AddEvent(LiqEvent{Key: key, TimestampMs: tsMs, NotionalUSD: notionalUSD})
}

// AddEvent appends one event with whatever detail its source carried.
func (w *SlidingWindow) AddEvent(e LiqEvent) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.appendLocked(windowEntry{key: e.Key, tsMs: e.TimestampMs, notional: e.NotionalUSD,
		collateral: e.CollateralUSD, leverage: e.Leverage,
		hasForfeit: e.HasForfeitDetail, lossPct: e.LossAtTriggerPct, returnedUSD: e.ReturnedUSD,
		hasFeeSplit: e.HasFeeSplit, feeAndCarryUSD: e.FeeAndCarryUSD})
}

// Upsert stores a bucketed figure: if the key is already in the window its
// notional and timestamp are replaced, otherwise the entry is appended.
// Returns true when the stored value changed, so callers can log movement.
func (w *SlidingWindow) Upsert(key string, tsMs int64, notionalUSD float64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if i, ok := w.byKey[key]; ok {
		if w.entries[i].notional == notionalUSD {
			return false
		}
		w.entries[i].notional = notionalUSD
		w.entries[i].tsMs = tsMs
		return true
	}
	w.appendLocked(windowEntry{key: key, tsMs: tsMs, notional: notionalUSD})
	return true
}

// Remove drops the entry held under key, if any. A bucket source that
// restates its figure as zero is saying the window no longer holds that
// hour or that total, and the entry must go rather than linger at its last
// non-zero value until it ages out. Returns true when something was removed.
func (w *SlidingWindow) Remove(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	i, ok := w.byKey[key]
	if !ok {
		return false
	}
	w.entries = append(w.entries[:i], w.entries[i+1:]...)
	w.byKey = make(map[string]int, len(w.entries))
	for j, e := range w.entries {
		w.byKey[e.key] = j
	}
	return true
}

func (w *SlidingWindow) appendLocked(e windowEntry) {
	w.entries = append(w.entries, e)
	w.byKey[e.key] = len(w.entries) - 1
}

// Prune drops entries older than span relative to nowMs.
func (w *SlidingWindow) Prune(nowMs int64) {
	cutoff := nowMs - w.span.Milliseconds()
	w.mu.Lock()
	defer w.mu.Unlock()
	kept := w.entries[:0]
	for _, e := range w.entries {
		if e.tsMs >= cutoff {
			kept = append(kept, e)
		}
	}
	// Zero the tail so pruned entries do not linger in the backing array.
	for i := len(kept); i < len(w.entries); i++ {
		w.entries[i] = windowEntry{}
	}
	w.entries = kept
	// The index holds positions, so it has to be rebuilt after a compaction.
	w.byKey = make(map[string]int, len(kept))
	for i, e := range kept {
		w.byKey[e.key] = i
	}
}

// Sum returns the total notional currently inside the window.
func (w *SlidingWindow) Sum() float64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	total := 0.0
	for _, e := range w.entries {
		total += e.notional
	}
	return total
}

// Max returns the largest single notional currently inside the window, which
// says whether the 24h figure is a flow or one position.
func (w *SlidingWindow) Max() float64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	max := 0.0
	for _, e := range w.entries {
		if e.notional > max {
			max = e.notional
		}
	}
	return max
}

// SumCollateral returns the total collateral behind the window's entries and
// whether any entry carried one; a source that does not expose collateral
// leaves the figure absent rather than at zero.
func (w *SlidingWindow) SumCollateral() (float64, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	total, any := 0.0, false
	for _, e := range w.entries {
		if e.collateral > 0 {
			total += e.collateral
			any = true
		}
	}
	return total, any
}

// MedianLeverage returns the median leverage of the entries that carry one,
// and whether any did.
func (w *SlidingWindow) MedianLeverage() (float64, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	levs := make([]float64, 0, len(w.entries))
	for _, e := range w.entries {
		if e.leverage > 0 {
			levs = append(levs, e.leverage)
		}
	}
	if len(levs) == 0 {
		return 0, false
	}
	return median(levs), true
}

// forfeitShares is one entry's forfeited-collateral arithmetic, all three in
// percentage points of the margin behind the position:
//
//	loss      what the price had taken when the venue closed the position
//	returned  what went back to the trader
//	forfeited 100 minus the other two, for this close
//
// forfeited is the collateral destroyed *in excess of the loss the trader
// actually incurred*: the closing and liquidation fees, the carry accrued, and
// whatever the venue keeps. It is the figure a trader asked for and the reason
// the notional rate above cannot answer them.
//
// Both ends are clamped. A loss can read above 100% of the margin, because a
// venue can close a position later than its margin lasted and then absorb the
// difference (Ostium had one such row in 91 over 7 days, at 116%); the trader
// forfeited nothing beyond their loss in that case, so forfeited is 0 rather
// than a negative number that reads as money handed back.
type forfeitShares struct {
	loss      float64
	returned  float64
	forfeited float64
}

func (e windowEntry) forfeit() (forfeitShares, bool) {
	if !e.hasForfeit || e.collateral <= 0 {
		return forfeitShares{}, false
	}
	loss := e.lossPct
	if loss < 0 {
		loss = 0
	}
	if loss > 100 {
		loss = 100
	}
	ret := e.returnedUSD / e.collateral * 100
	if ret < 0 {
		ret = 0
	}
	if ret > 100 {
		ret = 100
	}
	forf := 100 - loss - ret
	if forf < 0 {
		forf = 0
	}
	return forfeitShares{loss: loss, returned: ret, forfeited: forf}, true
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sort.Float64s(xs)
	if n := len(xs); n%2 == 1 {
		return xs[n/2]
	}
	n := len(xs)
	return (xs[n/2-1] + xs[n/2]) / 2
}

// ForfeitStats returns the medians of the three shares over the entries that
// carry them, and how many did. The medians rather than the aggregate ratio:
// the question is what a trader's position loses, and one 200,000 dollar
// position would otherwise be the whole answer for a venue whose other
// hundred positions were a few hundred dollars each.
//
// The three are independent medians over the same set of closes, so they do not
// add to 100. The subtraction happens per close, in forfeit(), and a median is
// not linear: on GMX over the 24h to 2026-09-29 the medians came out at 63.3%
// lost, 18.6% returned and 15.4 points forfeited, and 100 - 63.3 - 18.6 is
// 18.1. Every published figure is the median of a real per-close quantity;
// none of them is derived from the other two.
func (w *SlidingWindow) ForfeitStats() forfeitSummary {
	w.mu.Lock()
	defer w.mu.Unlock()
	var fs, ls, rs, cs []float64
	for _, e := range w.entries {
		s, ok := e.forfeit()
		if !ok {
			continue
		}
		// A venue-level median is computed only inside the range every venue
		// offers. Outside it the figure describes a product range: Gains'
		// all-leverage median is 40.0 points and its 10x to 100x median is
		// 32.8, because 45% of its liquidations sit above 100x where GMX has
		// none at all.
		if !inComparableRange(e.leverage) {
			continue
		}
		fs = append(fs, s.forfeited)
		ls = append(ls, s.loss)
		rs = append(rs, s.returned)
		if e.hasFeeSplit && e.collateral > 0 {
			c := e.feeAndCarryUSD / e.collateral * 100
			if c < 0 {
				c = 0
			}
			if c > 100 {
				c = 100
			}
			cs = append(cs, c)
		}
	}
	if len(fs) == 0 {
		return forfeitSummary{}
	}
	out := forfeitSummary{Forfeited: median(fs), Loss: median(ls),
		Returned: median(rs), N: len(fs)}
	if len(cs) > 0 {
		out.FeeAndCarry, out.HasFeeSplit = median(cs), true
	}
	return out
}

// forfeitSummary is one row's venue-level figures, every one of them a median
// over the closes inside the comparable leverage range.
type forfeitSummary struct {
	Forfeited   float64
	Loss        float64
	Returned    float64
	FeeAndCarry float64 // the itemised part of the forfeit, where the feed splits it
	HasFeeSplit bool
	N           int
}

// MarginDestroyedUSD is the margin the window's forced closes actually consumed:
// the margin behind them less whatever came back. The numerator of the
// leverage-neutral rate, because both halves are then money the trader posted
// rather than notional, and notional counts a 100x position at a hundred times
// the money behind it.
func (w *SlidingWindow) MarginDestroyedUSD() (float64, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	total, any := 0.0, false
	for _, e := range w.entries {
		if !e.hasForfeit || e.collateral <= 0 {
			continue
		}
		d := e.collateral - e.returnedUSD
		if d < 0 {
			d = 0
		}
		total += d
		any = true
	}
	return total, any
}

// leverageBands are the bands every cross-venue figure here is computed within.
//
// They are not a nicety. The forfeit *grows* with leverage, against the
// intuition: a position opened at 100x is closed after a smaller move, so less
// of its margin has been taken by the price by the time the venue takes the
// rest. So a venue-level median is mostly a statement about the venue's
// leverage mix, and the venues do not sell the same mix. Measured on the
// liquidated positions themselves, 2026-09-29: Gains' median was 91x with 45%
// above 100x and a maximum of 803x, GMX's median 45x with 2% above 100x and
// nothing past 107x, Ostium's median 66x with 0.5% above 100x. Gains' own group
// settings allow 200x on crypto, 500x on crypto-degen and 1000x on forex.
// Comparing one venue's all-leverage median against another's says which sells
// more leverage, not which manages risk better.
var leverageBands = []struct {
	name        string
	minEx, maxI float64 // (minEx, maxI]; maxI 0 means no upper bound
}{
	{"0-5x", 0, 5},
	{"5-10x", 5, 10},
	{"10-25x", 10, 25},
	{"25-50x", 25, 50},
	{"50-100x", 50, 100},
	{"100-200x", 100, 200},
	{"200x+", 200, 0},
}

// comparableLeverageMin and comparableLeverageMax bound the range every venue
// in this cohort actually offers and actually liquidates inside, so a
// venue-level figure computed over it compares risk management rather than
// product range. 10x to 100x is where all three venues that report the position
// hold real counts (Gains 418 closes, GMX 968, Ostium 366 over the windows
// measured on 2026-09-29). Outside it the comparison breaks down in both
// directions: GMX recorded no liquidation above 107x and Ostium two above 100x,
// while Gains had 244 above 200x, a region the other two do not sell.
//
// The per-band gauges carry the whole curve. Only the venue-level medians are
// restricted, because those are the ones a reader compares across rows.
const (
	comparableLeverageMin = 10.0
	comparableLeverageMax = 100.0
)

// leverageBandOf names the band a leverage falls in, or "" when the source did
// not report one. Bands are (min, max]: 10x sits in 0-10x territory, which here
// is 5-10x, and 100x in 50-100x, so a venue whose cap is a round number does not
// spill a band above it.
func leverageBandOf(lev float64) string {
	if lev <= 0 {
		return ""
	}
	for _, b := range leverageBands {
		if lev > b.minEx && (b.maxI == 0 || lev <= b.maxI) {
			return b.name
		}
	}
	return ""
}

// inComparableRange reports whether a leverage sits inside the range every
// venue here offers, which is what a venue-level median may be computed over.
func inComparableRange(lev float64) bool {
	return lev > comparableLeverageMin && lev <= comparableLeverageMax
}

// bandStats is one leverage band's figures. The count travels with the medians
// because a median over two positions is those two positions, and a band a
// venue does not sell has no cell at all rather than a zero.
type bandStats struct {
	Forfeited float64
	Loss      float64
	N         int
}

// ForfeitByBand returns the median forfeited share, the median loss at trigger
// and the count per leverage band, over every entry that carries a leverage and
// the forfeit detail. Unlike the venue-level medians this covers the whole
// curve: the bands are what makes the venues comparable, so none is dropped.
func (w *SlidingWindow) ForfeitByBand() map[string]bandStats {
	w.mu.Lock()
	defer w.mu.Unlock()
	type acc struct{ forf, loss []float64 }
	byBand := make(map[string]*acc, len(leverageBands))
	for _, e := range w.entries {
		s, ok := e.forfeit()
		if !ok {
			continue
		}
		band := leverageBandOf(e.leverage)
		if band == "" {
			continue
		}
		a := byBand[band]
		if a == nil {
			a = &acc{}
			byBand[band] = a
		}
		a.forf = append(a.forf, s.forfeited)
		a.loss = append(a.loss, s.loss)
	}
	out := make(map[string]bandStats, len(byBand))
	for band, a := range byBand {
		out[band] = bandStats{Forfeited: median(a.forf), Loss: median(a.loss), N: len(a.forf)}
	}
	return out
}

// NewestMs returns the timestamp of the most recent entry, or 0 when empty.
// Published as an age so a feed that has stopped reporting is visible next
// to the rate it still produces.
func (w *SlidingWindow) NewestMs() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	var newest int64
	for _, e := range w.entries {
		if e.tsMs > newest {
			newest = e.tsMs
		}
	}
	return newest
}

// Entries returns a copy of the entries held, for persisting the window.
func (w *SlidingWindow) Entries() []windowEntry {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]windowEntry, len(w.entries))
	copy(out, w.entries)
	return out
}

// Len returns the number of entries currently inside the window.
func (w *SlidingWindow) Len() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.entries)
}

// SampleWindow holds a 24h trail of point-in-time readings and answers their
// mean and their peak. Open interest is an instant, the liquidation sum is a
// 24h total, and dividing one by the other made the published rate jump with
// the denominator rather than the numerator: Gains read 343% on 2026-09-24
// because its open interest fell from $37M to $7.3M while the numerator stood
// still. The mean over the window was the first repair and it is not enough
// when the book collapses inside the window because it was liquidated: on
// 2026-09-28 Gains ETH went from $43.7M to $2.1M of open interest, the mean
// was $10.9M, and $27.3M of liquidations read as 251%. The denominator this
// bench divides by is the peak: the largest book the venue was observed
// holding during the window. A figure above 100% is then turnover, not a
// denominator artifact: a position opened after the peak reading, or opened
// and closed between two readings, counts in the numerator and never enters
// the denominator.
type SampleWindow struct {
	mu      sync.Mutex
	samples []windowEntry // key unused; tsMs + value
	span    time.Duration
}

// NewSampleWindow returns a sample window covering the given span.
func NewSampleWindow(span time.Duration) *SampleWindow {
	return &SampleWindow{span: span}
}

// Add records one reading and drops readings older than the span.
func (s *SampleWindow) Add(tsMs int64, value float64) {
	s.mu.Lock()
	s.samples = append(s.samples, windowEntry{tsMs: tsMs, notional: value})
	s.mu.Unlock()
	s.Prune(tsMs)
}

// Prune drops readings older than the span relative to nowMs. Called every
// tick, not only on Add: an open-interest endpoint that has been failing for
// more than a day would otherwise leave the window holding readings from
// before the outage, and the peak and the mean would describe a book the
// venue no longer has.
func (s *SampleWindow) Prune(nowMs int64) {
	cutoff := nowMs - s.span.Milliseconds()
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.samples[:0]
	for _, e := range s.samples {
		if e.tsMs >= cutoff {
			kept = append(kept, e)
		}
	}
	for i := len(kept); i < len(s.samples); i++ {
		s.samples[i] = windowEntry{}
	}
	s.samples = kept
}

// TimeWeightedMean returns the mean of the readings weighted by how long each
// stood before the next, which is the only honest mean once the readings come
// from events rather than from a timer.
//
// Event density is wildly uneven: Gains ETH had 67 open-interest events across
// the whole of 2026-09-27 and 88 in the single hour 09-28 02h. An arithmetic
// mean over the readings would weight that one hour more than the preceding
// day and report the collapse as the average state of the book.
//
// Each reading stands from its own timestamp until the next, and the last
// stands until nowMs. With readings on a timer the two means agree, so this is
// also correct for the venues that are still sampled per tick.
func (s *SampleWindow) TimeWeightedMean(nowMs int64) float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.samples) == 0 {
		return 0
	}
	if len(s.samples) == 1 {
		return s.samples[0].notional
	}
	ordered := make([]windowEntry, len(s.samples))
	copy(ordered, s.samples)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].tsMs < ordered[j].tsMs })

	weighted, span := 0.0, int64(0)
	for i, e := range ordered {
		end := nowMs
		if i+1 < len(ordered) {
			end = ordered[i+1].tsMs
		}
		if end <= e.tsMs {
			continue
		}
		d := end - e.tsMs
		weighted += e.notional * float64(d)
		span += d
	}
	if span == 0 {
		// Every reading carries the same instant; fall back to the last.
		return ordered[len(ordered)-1].notional
	}
	return weighted / float64(span)
}

// Min returns the smallest reading held, or 0 when empty. Published beside the
// peak because a book that ran from 49.9M dollars to 1.1M inside one day is
// two different markets, and a reader has to be able to see that.
func (s *SampleWindow) Min() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.samples) == 0 {
		return 0
	}
	min := s.samples[0].notional
	for _, e := range s.samples {
		if e.notional < min {
			min = e.notional
		}
	}
	return min
}

// ReplaceAll swaps the window's contents for a reconstructed series, for a
// venue that can read its own open-interest history instead of accumulating
// readings one tick at a time.
func (s *SampleWindow) ReplaceAll(readings []windowEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.samples = append(s.samples[:0], readings...)
}

// Max returns the largest reading held, or 0 when empty.
func (s *SampleWindow) Max() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	max := 0.0
	for _, e := range s.samples {
		if e.notional > max {
			max = e.notional
		}
	}
	return max
}

// Samples returns a copy of the readings held, for persisting the window.
func (s *SampleWindow) Samples() []windowEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]windowEntry, len(s.samples))
	copy(out, s.samples)
	return out
}

// Bounds returns the oldest and newest reading timestamps and the count, so a
// caller can tell whether the window yet covers the span it is divided over.
func (s *SampleWindow) Bounds() (oldestMs, newestMs int64, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, e := range s.samples {
		if i == 0 || e.tsMs < oldestMs {
			oldestMs = e.tsMs
		}
		if e.tsMs > newestMs {
			newestMs = e.tsMs
		}
	}
	return oldestMs, newestMs, len(s.samples)
}

// Len returns how many readings the window holds.
func (s *SampleWindow) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.samples)
}

// SeenSet tracks deduplication keys together with the event timestamp so
// stale keys can be pruned alongside the sliding window.
type SeenSet struct {
	mu sync.Mutex
	m  map[string]int64
}

// NewSeenSet returns an empty SeenSet.
func NewSeenSet() *SeenSet {
	return &SeenSet{m: make(map[string]int64)}
}

// Add records key with its timestamp and reports whether the key was new.
func (s *SeenSet) Add(key string, tsMs int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[key]; ok {
		return false
	}
	s.m[key] = tsMs
	return true
}

// Prune deletes keys whose event timestamp is older than cutoffMs.
func (s *SeenSet) Prune(cutoffMs int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, ts := range s.m {
		if ts < cutoffMs {
			delete(s.m, k)
		}
	}
}

// Len returns the number of tracked keys.
func (s *SeenSet) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}
