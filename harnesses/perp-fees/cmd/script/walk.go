package main

import (
	"fmt"
	"strconv"
)

// Notional tiers measured on every venue in addition to the headline
// notional. The headline series perp_fees_all_in_bps stays defined at the
// configured notional (default $1000); the tier gauge
// perp_fees_all_in_bps_tier{notional="1000"|"10000"|"100000"|"1000000"} is
// alongside so existing dashboards and spec queries keep their meaning.
// The $1000 tier duplicates the headline series under the default config.
var tierNotionals = []float64{1000, 10000, 100000, 1000000}

func notionalLabel(n float64) string {
	return strconv.FormatFloat(n, 'f', -1, 64)
}

// bookLevel is one price level of an orderbook's ask side.
type bookLevel struct {
	Px float64
	Sz float64
}

// walkBookForNotional walks the ask side until $notional has been matched
// and returns the size-weighted effective price. Same math as the original
// per-venue walks: partial fill on the crossing level, 1% tolerance on the
// matched total, error when the book cannot fill the notional.
func walkBookForNotional(levels []bookLevel, notional float64) (float64, error) {
	matched := 0.0
	totalQty := 0.0
	for _, l := range levels {
		if l.Px <= 0 || l.Sz <= 0 {
			continue
		}
		levelCost := l.Px * l.Sz
		if matched+levelCost >= notional {
			partial := (notional - matched) / l.Px
			totalQty += partial
			matched = notional
			break
		}
		matched += levelCost
		totalQty += l.Sz
	}
	if matched < notional*0.99 || totalQty == 0 {
		return 0, fmt.Errorf("insufficient_depth: matched=%.2f of %.2f", matched, notional)
	}
	return notional / totalQty, nil
}

// totalBookNotional sums price*size across every level, giving the total
// visible USD depth on this side of the book.
func totalBookNotional(levels []bookLevel) float64 {
	total := 0.0
	for _, l := range levels {
		if l.Px <= 0 || l.Sz <= 0 {
			continue
		}
		total += l.Px * l.Sz
	}
	return total
}

// walkBookForNotionalCapped walks like walkBookForNotional but returns an
// error when the walk would consume more than maxFillRatio of the total
// visible book depth. Depth-capped venues (Paradex depth=100) can otherwise
// publish an eaten-through effective price when the tier notional is close
// to or larger than the visible book. Use this for venues where the fetched
// depth is a hard ceiling on visible liquidity.
func walkBookForNotionalCapped(levels []bookLevel, notional, maxFillRatio float64) (float64, error) {
	total := totalBookNotional(levels)
	if total > 0 && notional > total*maxFillRatio {
		return 0, fmt.Errorf("book_too_thin: %.2f of visible %.2f > %.0f%%", notional, total, maxFillRatio*100)
	}
	return walkBookForNotional(levels, notional)
}

// applyBookTiers walks the already-fetched ask levels once per tier notional
// and fills s.Tiers with taker fee + tier spread. Call it after s.TakerFeeBps
// is known. Costs no extra API calls: the book was fetched for the headline
// walk anyway.
//
// Honesty rule for thin books: if the fetched levels cannot fill a tier's
// notional we do NOT extrapolate from the last level. The tier is recorded
// in s.SkippedTiers instead, which increments perp_fees_tier_skipped_total
// and deletes the tier gauge series so the tier shows as missing data
// rather than a fake tight spread.
func applyBookTiers(s *PerpSample, levels []bookLevel, mid float64) {
	for _, n := range tierNotionals {
		effective, err := walkBookForNotional(levels, n)
		if err != nil {
			s.SkippedTiers = append(s.SkippedTiers, notionalLabel(n))
			continue
		}
		spread := (effective - mid) / mid * 10000
		s.Tiers = append(s.Tiers, TierSample{
			Notional:  notionalLabel(n),
			SpreadBps: spread,
			AllInBps:  s.TakerFeeBps + spread,
		})
	}
}

// applyBookTiersCapped is like applyBookTiers but skips any tier whose
// notional would consume more than maxFillRatio of the visible book depth.
// Use this on venues that expose a hard depth cap (e.g. Paradex depth=100)
// where the top of a shallow book gives a misleading "effective price" when
// the walk eats through the entire visible side.
func applyBookTiersCapped(s *PerpSample, levels []bookLevel, mid, maxFillRatio float64) {
	for _, n := range tierNotionals {
		effective, err := walkBookForNotionalCapped(levels, n, maxFillRatio)
		if err != nil {
			s.SkippedTiers = append(s.SkippedTiers, notionalLabel(n))
			continue
		}
		spread := (effective - mid) / mid * 10000
		s.Tiers = append(s.Tiers, TierSample{
			Notional:  notionalLabel(n),
			SpreadBps: spread,
			AllInBps:  s.TakerFeeBps + spread,
		})
	}
}

// applyFlatTiers publishes the same all-in figure at every tier. Used by the
// oracle-priced venues (GMX v2, gains.trade) where the harness-read cost is
// a fixed fraction of position size, so the bps figure does not change with
// notional. Callers document per venue why that is correct.
func applyFlatTiers(s *PerpSample) {
	for _, n := range tierNotionals {
		s.Tiers = append(s.Tiers, TierSample{
			Notional:  notionalLabel(n),
			SpreadBps: s.SpreadBps,
			AllInBps:  s.AllInBps,
		})
	}
}
