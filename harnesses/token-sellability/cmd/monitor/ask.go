package main

import (
	"context"
	"log"
)

// askAggregators puts the question to every aggregator for every token that
// failed, and records the two numbers the board divides.
//
// An aggregator whose request errors is NOT counted as having been asked.
// That matters more than it looks: asked is the denominator, so counting a
// timeout would quietly improve its score, and the best score on this board
// is "never routes into a token you cannot exit". A provider earns that by
// answering and declining, never by failing to answer.
func askAggregators(ctx context.Context, cfg config, failed map[string][]string) {
	for _, agg := range Aggregators() {
		for tier, tokens := range failed {
			asked, routed, failures := 0, 0, 0
			var lastErr error
			for _, tok := range tokens {
				ok, err := agg.WillQuote(ctx, tok, cfg.ethIn)
				if err != nil {
					failures++
					lastErr = err
					continue
				}
				asked++
				if ok {
					routed++
				}
			}
			// Published every sweep, including as a zero. Without it, a
			// missing asked series is ambiguous between three different
			// states (no failed tokens, an aggregator that is down, and a
			// stale binary), and the first time that mattered it cost an
			// afternoon of guessing at the deployment instead of reading
			// the measurement.
			row := rowSlug(agg.Slug(), tier)
			errorGauge.WithLabelValues(cfg.chain, agg.Slug(), tier, row).Set(float64(failures))
			log.Printf("[sellability] %s %s: asked %d, routed %d, failed %d%s",
				agg.Slug(), tier, asked, routed, failures, because(lastErr))
			if asked == 0 {
				// Nothing was established, so publish nothing. A zero here
				// would render as a perfect record on the one column where
				// perfect is the top of the board.
				askedGauge.DeleteLabelValues(cfg.chain, agg.Slug(), tier, row)
				routedGauge.DeleteLabelValues(cfg.chain, agg.Slug(), tier, row)
				continue
			}
			askedGauge.WithLabelValues(cfg.chain, agg.Slug(), tier, row).Set(float64(asked))
			routedGauge.WithLabelValues(cfg.chain, agg.Slug(), tier, row).Set(float64(routed))
		}
	}
}

// because renders the last error for the log line, and nothing at all when
// there was none, so a healthy sweep's line stays readable.
func because(err error) string {
	if err == nil {
		return ""
	}
	return " (" + err.Error() + ")"
}

// rowSlug is the board's row identifier for one aggregator at one tier.
//
// A panel value is matched to a row by a label equal to the ROW SLUG, and a
// tier partitions providers, so the same vendor appears twice under two
// slugs. The spec cannot rebuild that spelling from the metric in under the
// 200 characters a panel query is allowed, and a query that rebuilt it
// would be a second place for the convention to drift from. The harness
// publishes it instead, next to the tier it is derived from.
func rowSlug(agg, tier string) string {
	if tier == "same_block" {
		return agg + "-same-block"
	}
	return agg
}
