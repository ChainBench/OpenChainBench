package main

import (
	"log"
)

// scoreFromSurvey turns one sweep's survey into the two numbers the board
// divides, for the cohort of tokens whose sale failed.
//
// It no longer asks anything. The survey already put the question to every
// aggregator about every examined token, so the unsellable cohort is a filter
// over answers we hold rather than a second round of requests. That removes
// the double-ask the old code made for a token failing at both timings, where
// the answer never depended on the timing.
//
// An aggregator whose request errored is NOT counted as having been asked.
// That matters more than it looks: asked is the denominator, so counting a
// timeout would quietly improve its score, and the best score on this board
// is "never routes into a token you cannot exit". A provider earns that by
// answering and declining, never by failing to answer.
func scoreFromSurvey(cfg config, s *Survey, failed map[string][]string,
	symbols map[string]string) {
	for _, agg := range Aggregators() {
		for tier, tokens := range failed {
			asked, routed, unanswered := 0, 0, 0
			for _, tok := range tokens {
				quoted, answered := s.Quoted(tok, agg.Slug())
				if !answered {
					unanswered++
					continue
				}
				asked++
				askedTokenGauge.WithLabelValues(
					cfg.chain, agg.Slug(), tier, rowSlug(agg.Slug(), tier), tok,
					scoringRule).Set(1)
				if quoted {
					routed++
					routedTokenGauge.WithLabelValues(
						cfg.chain, agg.Slug(), tier, rowSlug(agg.Slug(), tier),
						tok, symbols[tok], scoringRule).Set(1)
				}
			}
			// Published every sweep, including as a zero. Without it, a
			// missing asked series is ambiguous between three different
			// states (no failed tokens, an aggregator that is down, and a
			// stale binary), and the first time that mattered it cost an
			// afternoon of guessing at the deployment instead of reading
			// the measurement.
			row := rowSlug(agg.Slug(), tier)
			errorGauge.WithLabelValues(cfg.chain, agg.Slug(), tier, row).
				Set(float64(unanswered))
			log.Printf("[sellability] %s %s: asked %d, routed %d, unanswered %d",
				agg.Slug(), tier, asked, routed, unanswered)
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
			askedTotal.WithLabelValues(cfg.chain, agg.Slug(), tier, row).Add(float64(asked))
			routedTotal.WithLabelValues(cfg.chain, agg.Slug(), tier, row).Add(float64(routed))
		}
	}
}

// publishCoverage records, per aggregator, how much of the whole examined
// cohort it was willing to quote. This is the denominator the rate questions
// need and the old code never collected: a share of the unsellable tokens
// says nothing about how selective an aggregator is overall.
func publishCoverage(cfg config, s *Survey, examined []string) {
	for _, agg := range Aggregators() {
		quotedN, answeredN := 0, 0
		for _, tok := range examined {
			quoted, answered := s.Quoted(tok, agg.Slug())
			if !answered {
				continue
			}
			answeredN++
			if quoted {
				quotedN++
			}
		}
		if answeredN == 0 {
			quotedGauge.DeleteLabelValues(cfg.chain, agg.Slug())
			surveyedGauge.DeleteLabelValues(cfg.chain, agg.Slug())
			continue
		}
		surveyedGauge.WithLabelValues(cfg.chain, agg.Slug()).Set(float64(answeredN))
		quotedGauge.WithLabelValues(cfg.chain, agg.Slug()).Set(float64(quotedN))
		quotedTotal.WithLabelValues(cfg.chain, agg.Slug()).Add(float64(quotedN))
		surveyedTotal.WithLabelValues(cfg.chain, agg.Slug()).Add(float64(answeredN))
	}
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
