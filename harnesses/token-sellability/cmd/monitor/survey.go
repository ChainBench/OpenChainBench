package main

import (
	"context"
	"errors"
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
// Everyone must be asked about the same tokens or the comparison is between
// different cohorts. That holds for the tokens the SCORE divides by, which
// surveyCohort puts at the front of the list and no budget may cut into; it
// does not require sending all five the same forty. Letting LI.FI's 75 per 20
// minutes set the sample for everyone was the first attempt, and it failed in
// the other direction: forty tokens a sweep earned LI.FI a two hour cooldown,
// so it answered one sweep in four and its row ended up dividing by 15 where
// the others divided by 26. See budgetOf.
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

// cooldowns remember when each aggregator asked to be left alone, across
// sweeps, because a window longer than a sweep is the whole point of the
// header and a per-sweep memory would forget it between attempts.
//
// LI.FI answered 40 of 40 with 429 on three consecutive sweeps. Its window is
// 20 minutes and ours is 15, so every sweep walked into the same wall and
// each blocked request pushed the wall further out. Nothing was wrong with
// the pace; what was wrong was asking at all.
var cooldowns sync.Map // slug -> time.Time, when it is fair to ask again

func coolingDown(slug string) (time.Duration, bool) {
	v, ok := cooldowns.Load(slug)
	if !ok {
		return 0, false
	}
	until, _ := v.(time.Time)
	if d := time.Until(until); d > 0 {
		return d, true
	}
	return 0, false
}

func coolDown(slug string, d time.Duration) {
	cooldowns.Store(slug, time.Now().Add(d))
}

// surveyRow is what one aggregator said about one token, graded.
type surveyRow struct {
	answer Answer
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
// A route carrying a reservation is still a route: the headline counts the
// harm, and a reservation does not stop you entering the token.
func (s *Survey) Quoted(token, agg string) (quoted, answered bool) {
	a, answered := s.Answer(token, agg)
	return a.Routes(), answered
}

// Answer is the graded version, which the columns beside the score read: a
// refusal that names the token is not the same claim as one that names the
// market, and only one of the two is a router protecting its caller.
func (s *Survey) Answer(token, agg string) (Answer, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rows[token][agg]
	if !ok || r.err != nil {
		return Unanswered, false
	}
	return r.answer, true
}

// runSurvey asks every aggregator about every token, each at its own pace and
// all of them at once, since they are different hosts and one slow answer
// should not hold up the rest.
func runSurvey(ctx context.Context, cfg config, tokens []string, mustN int,
	decimals map[string]int) *Survey {
	s := &Survey{rows: map[string]map[string]surveyRow{}}
	var wg sync.WaitGroup
	for _, agg := range Aggregators() {
		wg.Add(1)
		go func(a Aggregator) {
			defer wg.Done()
			if wait, cooling := coolingDown(a.Slug()); cooling {
				// Asking now would extend the window we are waiting out and
				// produce a column of unanswered requests that looks like an
				// outage rather than our own impatience.
				log.Printf("[sellability] survey %s: skipped, asked to wait %s",
					a.Slug(), wait.Round(time.Second))
				return
			}
			gap := paceOf(a.Slug())
			// Ask this one no more than its own published limit allows in a
			// sweep. LI.FI's row divided by 15 tokens where every other row
			// divided by 26, which made its rank a cohort artifact rather
			// than a measurement: on the same 15 tokens it ties Trnch at
			// 66.7% and the 14.1 point gap the board showed is not there.
			//
			// The cause was not ordering, since surveyCohort already puts
			// the failed tokens first. It was budget. LI.FI publishes 75
			// requests per 20 minutes, the survey handed it 40 tokens a
			// sweep, it earned a two hour cooldown and then skipped 22 of 30
			// sweeps without asking anything at all, never seeing those
			// sweeps' failed tokens.
			//
			// The budget can never cut into the failed tokens, which are the
			// prefix of this list and the only part the score divides by.
			ask := tokens
			if b := budgetOf(a.Slug()); b > 0 && b < len(ask) {
				if b < mustN {
					b = mustN
				}
				ask = ask[:b]
			}
			errs := 0
			var lastErr error
			start := time.Now()
			for _, tok := range ask {
				d, known := decimals[tok]
				if !known {
					d = 18
				}
				ans, err := a.WillQuote(ctx, tok, d, cfg.ethIn)
				var limited *rateLimited
				if errors.As(err, &limited) {
					coolDown(a.Slug(), limited.after)
					log.Printf("[sellability] survey %s: stopped after %d of %d, %s",
						a.Slug(), len(s.rows), len(ask), limited.Error())
					return
				}
				if err != nil {
					errs++
					lastErr = err
				}
				s.set(tok, a.Slug(), surveyRow{answer: ans, err: err})
				select {
				case <-ctx.Done():
					return
				case <-time.After(gap):
				}
			}
			// The reason, not just the count. A survey that reports "190
			// unanswered" and nothing else is what sent me looking at pacing
			// when the answer was a quota the API states in a header.
			log.Printf("[sellability] survey %s: %d of %d tokens, %d unanswered, %.0fs%s",
				a.Slug(), len(ask), len(tokens), errs,
				time.Since(start).Seconds(), because(lastErr))
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

// budgetOf is how many tokens one aggregator may be asked about in a single
// sweep, derived from the limit it publishes rather than from what we would
// like to send.
//
// Pacing alone was not enough. Spacing LI.FI's requests 8 seconds apart kept
// a single sweep inside the rate, and the sweep still spent 40 of its 56
// permitted requests, so a cooldown from any one sweep carried into the next
// two hours and it went silent for 22 of 30 sweeps. A row that answers one
// sweep in four divides by a different cohort from the rows that answer
// every sweep, and the comparison stops being a comparison.
//
// Answering every sweep about the few tokens that matter beats answering one
// sweep in four about forty. Zero means no cap.
func budgetOf(slug string) int {
	switch slug {
	case "lifi":
		// 75 per 20 minutes, so about 56 in a 15 minute sweep. Ten leaves
		// the cooldown well out of reach even when the failed cohort is
		// larger than usual.
		return 10
	case "trnch":
		// 30 per minute is not the binding constraint at a 2.1s pace.
		return 0
	default:
		return 0
	}
}
