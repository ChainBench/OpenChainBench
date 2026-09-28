package main

// runner.go: runTick is executed once per (venue, asset) pair per tick, in
// its own goroutine.

import (
	"errors"
	"log"
	"time"
)

// windowSpan is the sliding-window length the whole harness is built around.
const windowSpan = 24 * time.Hour

// liqFetchOverlap is subtracted from the high-water mark on every fetch. An
// indexer (the GMX squid, the Ostium subgraph, 0xArchive) can ingest a
// liquidation after the tick that should have seen it has already queried,
// and a strict since filter then never asks for that row again. Re-asking
// for the last two hours costs a handful of pages on the busiest tape; the
// SeenSet makes the repeat free. Bucket sources ignore since altogether.
const liqFetchOverlap = 2 * time.Hour

// pairState is the cross-tick state runTick reads and writes for one pair.
type pairState struct {
	window *SlidingWindow
	seen   *SeenSet
	oi     *SampleWindow
	// noEventDetail is set once the pair's source has handed over an hourly
	// bucket or a windowed total, and stays set: "largest single event" has
	// no meaning for such a row, including on a tick where the source hands
	// over nothing new.
	noEventDetail bool
	// unreadBeforeMs is the edge left by a read a page cap cut short: rows
	// older than it were never read. Zero when the window is whole. The row
	// does not rank while the edge is inside the window, and the edge clears
	// once it has aged out.
	unreadBeforeMs int64
}

// newPairState builds the windows for one venue+asset pair.
func newPairState() *pairState {
	return &pairState{
		window: NewSlidingWindow(windowSpan),
		seen:   NewSeenSet(),
		oi:     NewSampleWindow(windowSpan),
	}
}

// runTick performs one poll cycle for a single venue+asset pair: fetch
// liquidations since the last tick, fold them into the window, fetch open
// interest and the venue's 24h notional, then publish.
//
// sinceMs is the caller-managed high-water mark (unix ms) for liquidation
// fetches; on the first tick it is now-24h so venues with historical
// endpoints backfill the full window. runTick reports whether every fetch
// succeeded so the caller can advance sinceMs and aggregate venue health.
// On a fetch error the previously published gauges are intentionally left
// untouched.
func runTick(va VenueAsset, st *pairState, sinceMs int64) bool {
	now := time.Now()
	nowMs := now.UnixMilli()
	cutoffMs := nowMs - windowSpan.Milliseconds()

	ok := true
	hasLiqSource := va.Source.HasLiquidationSource()
	setSourceAvailable(va.Venue, hasLiqSource)

	var liqErr error
	if hasLiqSource {
		var events []LiqEvent
		events, liqErr = va.Source.FetchLiquidationsSince(va.Asset, sinceMs-liqFetchOverlap.Milliseconds())
		var partial *partialWindowError
		if errors.As(liqErr, &partial) {
			// The rows read are real and go into the window; what was not
			// read is older than all of them. The tick counts as a success
			// so the high-water mark advances and the next request fits,
			// and the row is held from ranking until the unread edge has
			// aged out of the window.
			if partial.OldestReadMs > st.unreadBeforeMs {
				st.unreadBeforeMs = partial.OldestReadMs
			}
			recordFetchError(va.Venue, va.Asset, "partial_window")
			log.Printf("[%s/%s] liquidations read short: %v; the row does not rank until the unread edge ages out", va.Venue, va.Asset, liqErr)
			liqErr = nil
		}
		if liqErr != nil {
			handleFetchError(va, "liquidations", liqErr)
			ok = false
		} else {
			added, updated := 0, 0
			for _, e := range events {
				if e.Aggregate || e.Bucket {
					st.noEventDetail = true
				}
				if e.Key == "" {
					continue
				}
				if e.Bucket {
					// A restated figure. Zero means the source no longer
					// holds anything for that key, so the entry goes;
					// otherwise the newest reading replaces the one held.
					if e.NotionalUSD <= 0 || e.TimestampMs < cutoffMs {
						if st.window.Remove(e.Key) {
							updated++
						}
						continue
					}
					if st.window.Upsert(e.Key, e.TimestampMs, e.NotionalUSD) {
						updated++
					}
					continue
				}
				if e.TimestampMs <= 0 || e.NotionalUSD <= 0 {
					continue
				}
				if e.TimestampMs < cutoffMs {
					continue // older than the window; irrelevant
				}
				if st.seen.Add(e.Key, e.TimestampMs) {
					st.window.AddEvent(e)
					added++
				}
			}
			if added > 0 || updated > 0 {
				log.Printf("[%s/%s] +%d event(s), %d bucket(s) restated, window now %d entry(ies)",
					va.Venue, va.Asset, added, updated, st.window.Len())
			}
		}
	}

	st.window.Prune(nowMs)
	st.seen.Prune(cutoffMs)
	if st.unreadBeforeMs > 0 && st.unreadBeforeMs <= cutoffMs {
		st.unreadBeforeMs = 0
	}

	oi, oiErr := va.Source.FetchOI(va.Asset)
	if oiErr != nil {
		handleFetchError(va, "oi", oiErr)
		ok = false
	}

	// The venue's notional feeds the rank gate and nothing else. A failed
	// read is counted and logged, and the gate refuses the row for the
	// tick, but it does not fail the tick: the liquidation and OI reads
	// stand, health stays honest about them, and the high-water mark
	// keeps advancing.
	vol, hasVolSource, volErr := venueVolume24h(va.Source, va.Asset)
	if volErr != nil {
		handleFetchError(va, "volume", volErr)
	}

	// Publish OI unconditionally (all venues have OI).
	if oiErr == nil {
		if oi > 0 {
			liqOpenInterest.WithLabelValues(va.Venue, va.Asset).Set(oi)
			st.oi.Add(nowMs, oi)
		} else {
			recordFetchError(va.Venue, va.Asset, "oi_zero")
			log.Printf("[%s/%s] OI endpoint returned non-positive value %.4f; keeping previous OI gauge", va.Venue, va.Asset, oi)
			ok = false
		}
	}
	// The denominator and the rate wait for the window to hold enough
	// readings. One reading is the instantaneous open interest whose swings
	// this bench stopped publishing, and after a restart the numerator is a
	// full 24h backfill against it, so the first hour would show the 343%
	// class of artifact on the page as the latest reading.
	peakOI, meanOI := st.oi.Max(), st.oi.Mean()
	oiReady := st.oi.Len() >= minOISamples
	if oiReady && peakOI > 0 {
		liqOpenInterestPeak.WithLabelValues(va.Venue, va.Asset).Set(peakOI)
		liqOpenInterestAvg.WithLabelValues(va.Venue, va.Asset).Set(meanOI)
	}

	if hasVolSource && volErr == nil && vol > 0 {
		liqVenueVolume.WithLabelValues(va.Venue, va.Asset).Set(vol)
	}

	// liq_volume and liq_rate are published only for venues with a
	// liquidation source; an absent series reads as N/A on the site rather
	// than as a 0% that nobody can tell from a real one.
	volume := 0.0
	largestShare := 0.0
	if hasLiqSource && liqErr == nil {
		volume = st.window.Sum()
		setLiqVolume(va.Venue, va.Asset, volume)
		if oiReady && peakOI > 0 {
			liqRate.WithLabelValues(va.Venue, va.Asset).Set(volume / peakOI * 100)
		}
		if newest := st.window.NewestMs(); newest > 0 {
			liqNewestAge.WithLabelValues(va.Venue, va.Asset).Set(float64(nowMs-newest) / 1000)
		}
		// The money behind the notional, where the source says. A window
		// that has emptied keeps its last figure like every other gauge
		// here; a source that never exposes collateral never publishes one.
		if col, ok := st.window.SumCollateral(); ok {
			liqCollateral.WithLabelValues(va.Venue, va.Asset).Set(col)
		}
		if lev, ok := st.window.MedianLeverage(); ok {
			liqMedianLeverage.WithLabelValues(va.Venue, va.Asset).Set(lev)
		}
		// Meaningless for a source that reports hours or the whole window as
		// one number: it would show the busiest hour, or 100%, and claim the
		// day was a single position.
		if !st.noEventDetail {
			if volume > 0 {
				largestShare = st.window.Max() / volume * 100
			}
			liqLargestShare.WithLabelValues(va.Venue, va.Asset).Set(largestShare)
		}
	}

	in := rankInput{
		hasSource: hasLiqSource,
		// An OI endpoint that answered zero is a failed read for the gate
		// as it is for health, not a tick that passes on the trailing peak.
		fetchOK:         liqErr == nil && oiErr == nil && oi > 0 && volErr == nil,
		partialWindow:   st.unreadBeforeMs > 0,
		oiSamples:       st.oi.Len(),
		liqUSD24h:       volume,
		peakOIUSD:       peakOI,
		volUSD24h:       vol,
		hasVolume:       hasVolSource,
		hasEventDetail:  !st.noEventDetail,
		largestEventPct: largestShare,
	}
	// The share is a measurement only when both sides were read this tick;
	// on a failed fetch or a venue with no notional it stays absent rather
	// than reading as a 0 that the panel text calls "an absence".
	if in.fetchOK && in.hasVolume && vol > 0 {
		liqShareOfVolume.WithLabelValues(va.Venue, va.Asset).Set(in.shareOfVolumePct())
	}
	ranked, reason := evaluateRank(in)
	setRanked(va.Venue, va.Asset, ranked)
	if !ranked {
		log.Printf("[%s/%s] not ranked: %s (liq24h=$%.2f peakOI=$%.2f meanOI=$%.2f vol24h=$%.2f share=%.5f%% largest=%.1f%%)",
			va.Venue, va.Asset, reason, volume, peakOI, meanOI, vol, in.shareOfVolumePct(), largestShare)
	}

	return ok
}

// handleFetchError classifies, counts and logs a fetch error, honoring the
// suppression flag used by venues that are marked unavailable repeatedly.
func handleFetchError(va VenueAsset, stage string, err error) {
	var ue *unavailableError
	if errors.As(err, &ue) && ue.suppressed {
		// After repeated consecutive unavailability the source asked us to
		// stay quiet (logged once at the threshold, see source_lighter.go).
		return
	}
	recordFetchError(va.Venue, va.Asset, classifyError(err))
	log.Printf("[%s/%s] %s fetch error: %v", va.Venue, va.Asset, stage, err)
}
