package main

// runner.go — runTick is executed once per (venue, asset) pair per tick, in
// its own goroutine.

import (
	"errors"
	"log"
	"time"
)

// windowSpan is the sliding-window length the whole harness is built around.
const windowSpan = 24 * time.Hour

// runTick performs one poll cycle for a single venue+asset pair:
// fetch liquidations since the last tick, dedup into the window, prune the
// window and seen-set, fetch OI, and publish gauges.
//
// sinceMs is the caller-managed high-water mark (unix ms) for liquidation
// fetches; on the first tick it is now-24h so venues with historical
// endpoints backfill the full window. runTick reports whether both fetches
// succeeded so the caller can advance sinceMs and aggregate venue health.
// On any error the previously published gauges are intentionally left
// untouched.
func runTick(va VenueAsset, w *SlidingWindow, seen *SeenSet, sinceMs int64) bool {
	now := time.Now()
	nowMs := now.UnixMilli()
	cutoffMs := nowMs - windowSpan.Milliseconds()
	w.MarkTick(now)

	ok := true

	events, liqErr := va.Source.FetchLiquidationsSince(va.Asset, sinceMs)
	if liqErr != nil {
		handleFetchError(va, "liquidations", liqErr)
		ok = false
	} else {
		added := 0
		for _, e := range events {
			if e.Key == "" || e.TimestampMs <= 0 || e.NotionalUSD <= 0 {
				continue
			}
			if e.TimestampMs < cutoffMs {
				continue // older than the window; irrelevant
			}
			if seen.Add(e.Key, e.TimestampMs) {
				w.Add(e.TimestampMs, e.NotionalUSD)
				added++
			}
		}
		if added > 0 {
			log.Printf("[%s/%s] +%d liquidation event(s), window now %d event(s)",
				va.Venue, va.Asset, added, w.Len())
		}
	}

	w.Prune(nowMs)
	seen.Prune(cutoffMs)

	oi, oiErr := va.Source.FetchOI(va.Asset)
	if oiErr != nil {
		handleFetchError(va, "oi", oiErr)
		ok = false
	}

	// Publish. Volume is valid whenever the liquidation fetch succeeded; the
	// rate additionally needs a positive OI. On failure the previous gauge
	// values are kept as-is (spec: "on error keep previous gauge").
	if liqErr == nil {
		volume := w.Sum()
		setLiqVolume(va.Venue, va.Asset, volume)
		if oiErr == nil {
			if oi > 0 {
				setOIAndRate(va.Venue, va.Asset, volume, oi)
			} else {
				recordFetchError(va.Venue, va.Asset, "oi_zero")
				log.Printf("[%s/%s] OI endpoint returned non-positive value %.4f; keeping previous OI/rate gauges", va.Venue, va.Asset, oi)
				ok = false
			}
		}
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
