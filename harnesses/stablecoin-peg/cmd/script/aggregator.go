package main

import (
	"math"
	"sort"
	"sync"
	"time"
)

// sample is one (stable, venue, quote) price observation tied to the
// minute it landed in.
type sample struct {
	stable      string
	venue       string
	quote       Quote
	price       float64
	liquidity   float64
	receivedAt  time.Time
	minuteBucket time.Time
}

// recentSample is one (price, time) observation kept in a rolling
// 30-second buffer per (stable, venue), used exclusively by the
// consensus outlier rule. We don't keep the full sample struct because
// nothing else in the consensus check needs the bucket / quote / liquidity.
type recentSample struct {
	price      float64
	receivedAt time.Time
}

// Consensus outlier rule constants. A sample more than
// consensusThreshold off peg is kept only when at least one OTHER venue
// has also been outside the band in the same direction within the last
// consensusWindow. Single-venue glitches get filtered. Multi-venue
// confirmation = real depeg signal preserved. Sanity floor at
// sanityCeiling because anything wider than that on a USD-quoted
// stable is a parser bug, not a market event.
const (
	consensusWindow    = 30 * time.Second
	consensusThreshold = 0.02
	sanityCeiling      = 0.50
)

// Aggregator collects per-venue samples, closes minute buckets,
// computes liquidity-weighted median per stable per minute, and
// updates the deviation metrics. Single-threaded internal logic
// behind a mutex — call from any goroutine.
type Aggregator struct {
	mu sync.Mutex
	// Current open minute bucket: map[stable] → map[venue] → []sample.
	// Holds only USD-quoted + pool-quoted samples (primary-eligible).
	primaryBucket map[string]map[string][]sample
	usdtBucket    map[string]map[string][]sample
	// Last closed minute's per-stable median price (used by the
	// depeg flag state machine).
	lastClosedPrice map[string]float64
	// Depeg flag state: streaks of consecutive out-of-band minutes.
	depegStreak   map[string]int
	recoveryStreak map[string]int
	depegActive   map[string]bool
	// Cumulative seconds outside band over a rolling 24h window.
	// We track a list of (minute, dev_bps, secs) for each stable
	// and evict entries older than 24h on each minute close.
	band ringBuffer
	// Current minute timestamp.
	currentMinute time.Time
	// Rolling 30s buffer of (price, time) per (stable, venue) used
	// by the consensus outlier rule to decide whether a >2% sample
	// is a single-venue glitch or a corroborated depeg event.
	// Every sample is recorded here regardless of accept/reject so
	// two venues that depeg simultaneously can validate each other
	// even when the first arrives before the second.
	recentByStableVenue map[string]map[string][]recentSample
}

func NewAggregator() *Aggregator {
	return &Aggregator{
		primaryBucket:       make(map[string]map[string][]sample),
		usdtBucket:          make(map[string]map[string][]sample),
		lastClosedPrice:     make(map[string]float64),
		depegStreak:         make(map[string]int),
		recoveryStreak:      make(map[string]int),
		depegActive:         make(map[string]bool),
		band:                newRingBuffer(percentileWindow),
		recentByStableVenue: make(map[string]map[string][]recentSample),
	}
}

// corroboratedLocked answers: at time `at`, with this `stable` showing
// `price` on `exceptVenue`, has at least one OTHER venue published a
// reading in the last consensusWindow that is ALSO outside the
// consensusThreshold band in the SAME direction (both above peg or both
// below peg)? If yes, the print is a corroborated depeg signal and
// should be kept. If no, it's a single-venue glitch and should be
// dropped. Caller holds a.mu.
func (a *Aggregator) corroboratedLocked(stable, exceptVenue string, price float64, at time.Time) bool {
	byVenue := a.recentByStableVenue[stable]
	if byVenue == nil {
		return false
	}
	cutoff := at.Add(-consensusWindow)
	subjectAbove := price > 1.0
	for venue, samples := range byVenue {
		if venue == exceptVenue {
			continue
		}
		for _, ss := range samples {
			if ss.receivedAt.Before(cutoff) {
				continue
			}
			otherDev := math.Abs(ss.price - 1.0)
			if otherDev <= consensusThreshold {
				continue
			}
			if (ss.price > 1.0) == subjectAbove {
				return true
			}
		}
	}
	return false
}

// recordRecentLocked appends the sample to the rolling 30s buffer for
// (stable, venue) and prunes entries that fell out of the window. We
// record every observed sample (including ones we drop via the
// consensus rule) because the rule cares about "what has the source
// recently published," not "what we agreed to use." Caller holds a.mu.
func (a *Aggregator) recordRecentLocked(s sample) {
	if a.recentByStableVenue[s.stable] == nil {
		a.recentByStableVenue[s.stable] = make(map[string][]recentSample)
	}
	cutoff := s.receivedAt.Add(-consensusWindow)
	prev := a.recentByStableVenue[s.stable][s.venue]
	pruned := prev[:0]
	for _, ss := range prev {
		if !ss.receivedAt.Before(cutoff) {
			pruned = append(pruned, ss)
		}
	}
	pruned = append(pruned, recentSample{price: s.price, receivedAt: s.receivedAt})
	a.recentByStableVenue[s.stable][s.venue] = pruned
}

// Ingest accepts a fresh sample from a source goroutine.
// Applies the consensus outlier rule synchronously; rejected samples
// are counted via peg_source_call_total and never reach the buckets.
//
// Consensus outlier rule (replaces the old flat 20% drop / 10% cap):
//
//   - >sanityCeiling (50%) off peg → drop. This is a parser bug,
//     not a market event, on any USD-quoted stable.
//   - >consensusThreshold (2%) off peg → keep only if at least one
//     OTHER venue has also been outside the threshold in the SAME
//     direction within the last consensusWindow (30s). This
//     distinguishes a single-venue glitch (Kraken returns $0.97
//     while every other venue is at $1.00 = stale print, drop) from
//     a corroborated depeg (Kraken AND Bitstamp both at $0.87 = real
//     event, keep all samples so the percentile metric surfaces it).
//   - ≤2% off peg → always keep, this is normal noise.
//
// Every sample (even rejected ones) is also recorded in the rolling
// 30s buffer so that two venues which depeg within the same 30s
// window can validate each other regardless of arrival order.
//
// This is the rule the Coinpaprika data team review identified as the
// single most important fix to the bench: the old 20% drop / 10% cap
// would clip USDC at $0.87 (March 2023 SVB) to $0.90, erasing the
// event in the percentile metric.
func (a *Aggregator) Ingest(s sample) {
	dev := math.Abs(s.price - 1.0)

	a.mu.Lock()
	defer a.mu.Unlock()

	// Record in the rolling buffer before applying the rule so the
	// next venue to observe a corroborating print can find this one.
	a.recordRecentLocked(s)

	if dev > sanityCeiling {
		pegSourceCallTotal.WithLabelValues(s.stable, s.venue, "dropped_sanity").Inc()
		return
	}
	if dev > consensusThreshold {
		if a.corroboratedLocked(s.stable, s.venue, s.price, s.receivedAt) {
			pegSourceCallTotal.WithLabelValues(s.stable, s.venue, "kept_corroborated").Inc()
		} else {
			pegSourceCallTotal.WithLabelValues(s.stable, s.venue, "dropped_isolated").Inc()
			return
		}
	}

	pegRawPrice.WithLabelValues(s.stable, s.venue, string(s.quote)).Set(s.price)
	pegSourceCallTotal.WithLabelValues(s.stable, s.venue, "ok").Inc()
	pegSourceHealth.WithLabelValues(s.stable, s.venue).Set(1)

	// Roll the minute bucket if needed.
	now := s.receivedAt
	bucket := now.Truncate(minuteBucketSize)
	if a.currentMinute.IsZero() {
		a.currentMinute = bucket
	}
	if bucket.After(a.currentMinute) {
		a.closeMinuteLocked(a.currentMinute)
		a.currentMinute = bucket
	}

	// USDT-quoted goes into the secondary bucket; USD + pool go
	// to primary.
	if s.quote == QuoteUSDT {
		if a.usdtBucket[s.stable] == nil {
			a.usdtBucket[s.stable] = make(map[string][]sample)
		}
		a.usdtBucket[s.stable][s.venue] = append(a.usdtBucket[s.stable][s.venue], s)
		// Also emit the secondary metric live for chart purposes.
		pegDeviationUsdtAnchoredBps.WithLabelValues(s.stable, s.venue).Set(math.Abs(s.price-1.0) * 10000)
	} else {
		if a.primaryBucket[s.stable] == nil {
			a.primaryBucket[s.stable] = make(map[string][]sample)
		}
		a.primaryBucket[s.stable][s.venue] = append(a.primaryBucket[s.stable][s.venue], s)
	}
}

// FlushMinuteLoop runs forever, closing the current minute every
// minuteBucketSize. Safety net for stables with no samples in the
// current minute — without this, a quiet stable's metrics would go
// stale.
func (a *Aggregator) FlushMinuteLoop() {
	t := time.NewTicker(minuteBucketSize)
	defer t.Stop()
	for range t.C {
		a.mu.Lock()
		nowBucket := time.Now().Truncate(minuteBucketSize)
		if !a.currentMinute.IsZero() && nowBucket.After(a.currentMinute) {
			a.closeMinuteLocked(a.currentMinute)
			a.currentMinute = nowBucket
		}
		a.mu.Unlock()
	}
}

// closeMinuteLocked finalizes the closing minute: per-stable
// liquidity-weighted median across venues, deviation in bps, cross-
// venue gap, band accounting, depeg flag state machine. Caller
// holds a.mu.
func (a *Aggregator) closeMinuteLocked(closedMinute time.Time) {
	for stable, byVenue := range a.primaryBucket {
		// Per-venue median price + sample count.
		venuePrices := make([]struct {
			price     float64
			liquidity float64
			venue     string
		}, 0, len(byVenue))
		for venue, samples := range byVenue {
			if len(samples) == 0 {
				continue
			}
			pegMinuteSampleCount.WithLabelValues(stable, venue).Set(float64(len(samples)))
			vp := medianPrice(samples)
			venuePrices = append(venuePrices, struct {
				price     float64
				liquidity float64
				venue     string
			}{vp, samples[0].liquidity, venue})
		}
		if len(venuePrices) == 0 {
			continue
		}

		// Liquidity-weighted median across venues. Sort by price,
		// walk cumulative weight to the midpoint.
		sort.Slice(venuePrices, func(i, j int) bool {
			return venuePrices[i].price < venuePrices[j].price
		})
		totalW := 0.0
		for _, vp := range venuePrices {
			totalW += vp.liquidity
		}
		half := totalW / 2
		acc := 0.0
		aggPrice := venuePrices[0].price
		for _, vp := range venuePrices {
			acc += vp.liquidity
			if acc >= half {
				aggPrice = vp.price
				break
			}
		}

		// Emit aggregated price + deviation gauge + histogram.
		devBps := math.Abs(aggPrice-1.0) * 10000
		pegAggregatedPrice.WithLabelValues(stable).Set(aggPrice)
		pegDeviationBps.WithLabelValues(stable).Set(devBps)
		pegDeviationHist.WithLabelValues(stable).Observe(devBps)

		// OHLC pass: compute open/high/low/close on the per-minute
		// |price-1| series across every venue sample in the bucket,
		// in chronological order. The median we computed above is
		// what the bench reports as the "typical" value within the
		// minute; the high (worst) is what a depeg detector or a
		// stress-aware integrator needs to see. A 5-second print to
		// $0.92 is invisible in the median, undeniable in the high.
		var (
			firstTime, lastTime time.Time
			firstDev, lastDev   float64
			maxDev              float64
			minDev              = math.MaxFloat64
			haveAny             bool
		)
		for _, samples := range byVenue {
			for _, s := range samples {
				dev := math.Abs(s.price-1.0) * 10000
				if !haveAny || s.receivedAt.Before(firstTime) {
					firstTime = s.receivedAt
					firstDev = dev
				}
				if !haveAny || s.receivedAt.After(lastTime) {
					lastTime = s.receivedAt
					lastDev = dev
				}
				if dev > maxDev {
					maxDev = dev
				}
				if dev < minDev {
					minDev = dev
				}
				haveAny = true
			}
		}
		if haveAny {
			pegDeviationWorstBps.WithLabelValues(stable).Set(maxDev)
			pegMinuteMaxBps.WithLabelValues(stable).Set(maxDev)
			pegMinuteMinBps.WithLabelValues(stable).Set(minDev)
			pegMinuteOpenBps.WithLabelValues(stable).Set(firstDev)
			pegMinuteCloseBps.WithLabelValues(stable).Set(lastDev)
		}

		// Cross-venue gap = max - min in bps. Only meaningful with
		// ≥2 venues in the same minute.
		if len(venuePrices) >= 2 {
			gap := (venuePrices[len(venuePrices)-1].price - venuePrices[0].price) * 10000
			pegCrossVenueGapBps.WithLabelValues(stable).Set(gap)
			pegCrossVenueGapHist.WithLabelValues(stable).Observe(gap)
		}

		a.lastClosedPrice[stable] = aggPrice

		// Band accounting: how far outside [0.995, 1.005] are we?
		below := aggPrice < 0.995
		above := aggPrice > 1.005
		secondsThisMinute := float64(60)
		a.band.add(stable, closedMinute, aggPrice)

		out, belowSec, aboveSec := a.band.bandsOver(stable, percentileWindow)
		pegTimeOutsideBandSec.WithLabelValues(stable).Set(out)
		pegTimeBelowPegSec.WithLabelValues(stable).Set(belowSec)
		pegTimeAbovePegSec.WithLabelValues(stable).Set(aboveSec)

		// Depeg event flag state machine.
		offRange := aggPrice < 0.97 || aggPrice > 1.03
		if offRange {
			a.depegStreak[stable]++
			a.recoveryStreak[stable] = 0
			if a.depegStreak[stable] >= 5 && !a.depegActive[stable] {
				a.depegActive[stable] = true
			}
		} else {
			a.recoveryStreak[stable]++
			a.depegStreak[stable] = 0
			if a.recoveryStreak[stable] >= 30 && a.depegActive[stable] {
				a.depegActive[stable] = false
			}
		}
		flag := 0.0
		if a.depegActive[stable] {
			flag = 1.0
		}
		pegDepegEventFlag.WithLabelValues(stable).Set(flag)

		_ = below
		_ = above
		_ = secondsThisMinute
	}

	// Reset buckets for the next minute.
	a.primaryBucket = make(map[string]map[string][]sample)
	a.usdtBucket = make(map[string]map[string][]sample)
}

// medianPrice returns the median price across samples within one
// minute for a single venue (drops microsecond-level noise).
func medianPrice(samples []sample) float64 {
	prices := make([]float64, len(samples))
	for i, s := range samples {
		prices[i] = s.price
	}
	sort.Float64s(prices)
	return prices[len(prices)/2]
}

// ringBuffer keeps per-stable per-minute closed prices for the
// rolling window. Used by the band-time metrics.
type ringBuffer struct {
	window  time.Duration
	entries map[string][]ringEntry
	mu      sync.Mutex
}

type ringEntry struct {
	at    time.Time
	price float64
}

func newRingBuffer(window time.Duration) ringBuffer {
	return ringBuffer{window: window, entries: make(map[string][]ringEntry)}
}

func (r *ringBuffer) add(stable string, at time.Time, price float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[stable] = append(r.entries[stable], ringEntry{at, price})
	// Evict old entries.
	cutoff := at.Add(-r.window)
	es := r.entries[stable]
	keep := 0
	for keep < len(es) && es[keep].at.Before(cutoff) {
		keep++
	}
	if keep > 0 {
		r.entries[stable] = es[keep:]
	}
}

// bandsOver returns (outside_band_sec, below_band_sec, above_band_sec)
// across the rolling window. One minute counted = 60 seconds.
func (r *ringBuffer) bandsOver(stable string, _ time.Duration) (float64, float64, float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var below, above float64
	for _, e := range r.entries[stable] {
		switch {
		case e.price < 0.995:
			below += 60
		case e.price > 1.005:
			above += 60
		}
	}
	return below + above, below, above
}
