package main

import (
	"context"
	"log"
	"sync"
	"time"
)

// The survey asks every aggregator about every token examined this sweep,
// rather than only about the ones whose sale failed.
//
// Why it has to be every token. A rate needs a denominator. "Of the tokens
// KyberSwap agreed to quote, how many turned out to be unsellable" cannot be
// computed from a sample drawn only from the unsellable ones: that is a
// numerator looking for a denominator it never collected. Asking about every
// examined token costs four extra requests per token and makes the whole
// family of rate questions answerable, including the one this bench is
// heading for, which is the share that later rugs.
//
// It also removes waste. The old code asked once for the same-block cohort
// and again for the delayed one, so a token failing at both timings was
// asked about twice for an answer that does not depend on the timing at all.

// paceOf is how fast each aggregator may be asked, and surveyCap is how many
// tokens a sweep may put to them at all.
//
// Both numbers come from the aggregators themselves rather than from
// experiment. They publish their limits in response headers and the first
// version of this file did not read them, so a sweep of 200 tokens emptied
// LI.FI's budget in one pass and then failed 190 of 200 requests:
//
//	lifi       ratelimit-limit: 75, reset 1229s   about 75 per 20 minutes
//	trnch      ratelimit-policy: 30;w=60          30 per minute
//	kyberswap  no header; measured clean at 2/s, refusing at 2.9/s
//	sushi      no header; 40/40 clean at 6.7/s
//	paraswap   unmeasured, paced like kyberswap rather than guessed upwards
//
// LI.FI's budget is what binds the survey: 75 per 20 minutes is about 56 in a
// 15 minute sweep. Everyone must be asked about the SAME tokens or the
// comparison is between different cohorts, so the smallest budget sets the
// sample for all five.
//
// The examined cohort stays large, because examining is our own RPC and it is
// cheap. Only the asking is capped. A different sample each sweep accumulates
// over the window, which is where the board reads from anyway.
func paceOf(slug string) time.Duration {
	switch slug {
	case "lifi":
		return 8 * time.Second
	case "trnch":
		return 2100 * time.Millisecond
	case "kyberswap", "paraswap":
		return 500 * time.Millisecond
	default:
		return 200 * time.Millisecond
	}
}

// surveyRow is what one aggregator said about one token.
type surveyRow struct {
	quoted bool
	err    error
}

// Survey holds the answers, keyed by token then aggregator slug.
type Survey struct {
	mu   sync.Mutex
	rows map[string]map[string]surveyRow
}

func (s *Survey) set(token, agg string, r surveyRow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rows[token] == nil {
		s.rows[token] = map[string]surveyRow{}
	}
	s.rows[token][agg] = r
}

// Quoted reports whether this aggregator returned a usable route into the
// token. A request that errored is not a refusal and returns false for both.
func (s *Survey) Quoted(token, agg string) (quoted, answered bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rows[token][agg]
	if !ok || r.err != nil {
		return false, false
	}
	return r.quoted, true
}

// runSurvey asks every aggregator about every token, each at its own pace and
// all of them at once, since they are different hosts and one slow answer
// should not hold up the rest.
func runSurvey(ctx context.Context, cfg config, tokens []string,
	decimals map[string]int) *Survey {
	s := &Survey{rows: map[string]map[string]surveyRow{}}
	var wg sync.WaitGroup
	for _, agg := range Aggregators() {
		wg.Add(1)
		go func(a Aggregator) {
			defer wg.Done()
			gap := paceOf(a.Slug())
			errs := 0
			var lastErr error
			start := time.Now()
			for _, tok := range tokens {
				d, ok2 := decimals[tok]
				if !ok2 {
					d = 18
				}
				ok, err := a.WillQuote(ctx, tok, d, cfg.ethIn)
				if err != nil {
					errs++
					lastErr = err
				}
				s.set(tok, a.Slug(), surveyRow{quoted: ok, err: err})
				select {
				case <-ctx.Done():
					return
				case <-time.After(gap):
				}
			}
			// The reason, not just the count. A survey that reports "190
			// unanswered" and nothing else is what sent me looking at pacing
			// when the answer was a quota the API states in a header.
			log.Printf("[sellability] survey %s: %d tokens, %d unanswered, %.0fs%s",
				a.Slug(), len(tokens), errs, time.Since(start).Seconds(), because(lastErr))
		}(agg)
	}
	wg.Wait()
	return s
}

// because renders the last error for a log line, and nothing at all when
// there was none, so a healthy sweep's line stays readable.
func because(err error) string {
	if err == nil {
		return ""
	}
	return " (" + err.Error() + ")"
}

// surveyCohort picks which examined tokens to put to the aggregators.
//
// Every token whose sale failed is included, because those are what the
// board's columns are computed over and dropping one would silently shrink a
// published denominator. The rest of the budget is filled from the others, so
// the coverage denominator grows across sweeps rather than only ever
// describing the broken half of the cohort.
func surveyCohort(examined []string, failed map[string][]string, cap int) []string {
	must := map[string]bool{}
	for _, toks := range failed {
		for _, t := range toks {
			must[t] = true
		}
	}
	out := make([]string, 0, cap)
	for _, t := range examined {
		if must[t] {
			out = append(out, t)
		}
	}
	for _, t := range examined {
		if len(out) >= cap {
			break
		}
		if !must[t] {
			out = append(out, t)
		}
	}
	return out
}
