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
			asked, routed := 0, 0
			for _, tok := range tokens {
				ok, err := agg.WillQuote(ctx, tok, cfg.ethIn)
				if err != nil {
					continue
				}
				asked++
				if ok {
					routed++
				}
			}
			if asked == 0 {
				// Nothing was established, so publish nothing. A zero here
				// would render as a perfect record on the one column where
				// perfect is the top of the board.
				askedGauge.DeleteLabelValues(cfg.chain, agg.Slug(), tier)
				routedGauge.DeleteLabelValues(cfg.chain, agg.Slug(), tier)
				continue
			}
			askedGauge.WithLabelValues(cfg.chain, agg.Slug(), tier).Set(float64(asked))
			routedGauge.WithLabelValues(cfg.chain, agg.Slug(), tier).Set(float64(routed))
			if routed > 0 {
				log.Printf("[sellability] %s routes into %d of %d unsellable tokens (%s)",
					agg.Slug(), routed, asked, tier)
			}
		}
	}
}
