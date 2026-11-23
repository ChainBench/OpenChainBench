package main

import (
	"context"
	"errors"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

type fakeAgg struct {
	slug    string
	answers map[string]bool
	errs    map[string]error
}

func (f fakeAgg) Slug() string { return f.slug }

func (f fakeAgg) WillQuote(_ context.Context, token string, _ int, _ string) (Answer, error) {
	if e, ok := f.errs[token]; ok {
		return Unanswered, e
	}
	if f.answers[token] {
		return Routed, nil
	}
	return NoLiquidity, nil
}

// surveyOf builds the answers a survey would have collected, so the scoring
// can be driven without any network. Quoted and declined are answers; a token
// missing from both maps was never answered, which is a third state and must
// not collapse into "declined".
func surveyOf(agg string, quoted map[string]bool, unanswered ...string) *Survey {
	s := &Survey{rows: map[string]map[string]surveyRow{}}
	for tok, q := range quoted {
		a := NoLiquidity
		if q {
			a = Routed
		}
		s.set(tok, agg, surveyRow{answer: a})
	}
	for _, tok := range unanswered {
		s.set(tok, agg, surveyRow{err: errors.New("timeout")})
	}
	return s
}

func useAgg(t *testing.T, slug string) {
	t.Helper()
	for _, g := range []interface{ Reset() }{
		askedGauge, routedGauge, errorGauge, routedTokenGauge,
		surveyedGauge, quotedGauge, askedTokenGauge,
		screenedTokenGauge, noLiquidityTokenGauge, reservedTokenGauge,
	} {
		g.Reset()
	}
	old := aggregatorsForTest
	aggregatorsForTest = []Aggregator{fakeAgg{slug: slug}}
	t.Cleanup(func() { aggregatorsForTest = old })
}

// asked is the denominator, so an aggregator that times out on a token and is
// still counted as having been asked gets a quietly better score. The best
// score here is "never routes into a token you cannot exit", and that has to
// be earned by answering and declining.
func TestAnUnansweredRequestDoesNotCountAsAsked(t *testing.T) {
	useAgg(t, "sushi")
	s := surveyOf("sushi", map[string]bool{"0xa": true}, "0xb")
	scoreFromSurvey(config{chain: "robinhood"}, s,
		map[string][]string{"delayed": {"0xa", "0xb"}}, map[string]string{})

	asked := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "sushi", "delayed", "sushi"))
	routed := testutil.ToFloat64(routedGauge.WithLabelValues("robinhood", "sushi", "delayed", "sushi"))
	if asked != 1 || routed != 1 {
		t.Errorf("only the answered token counts, got asked=%v routed=%v", asked, routed)
	}
}

// Every request failing means nothing was established. Publishing a zero
// would put the aggregator at the top of the board for being unreachable.
func TestNothingAnsweredPublishesNothing(t *testing.T) {
	useAgg(t, "lifi")
	s := surveyOf("lifi", nil, "0xa", "0xb")
	scoreFromSurvey(config{chain: "robinhood"}, s,
		map[string][]string{"delayed": {"0xa", "0xb"}}, map[string]string{})

	if n := testutil.CollectAndCount(askedGauge); n != 0 {
		t.Errorf("an aggregator that answered nothing must publish nothing, got %d", n)
	}
	if n := testutil.CollectAndCount(routedGauge); n != 0 {
		t.Errorf("routed must be absent too, got %d", n)
	}
}

// Declining every token is the best possible record and must be published,
// not confused with the case above.
func TestDecliningEverythingIsRecorded(t *testing.T) {
	useAgg(t, "kyberswap")
	s := surveyOf("kyberswap", map[string]bool{"0xa": false, "0xb": false})
	scoreFromSurvey(config{chain: "robinhood"}, s,
		map[string][]string{"delayed": {"0xa", "0xb"}}, map[string]string{})

	asked := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "kyberswap", "delayed", "kyberswap"))
	routed := testutil.ToFloat64(routedGauge.WithLabelValues("robinhood", "kyberswap", "delayed", "kyberswap"))
	if asked != 2 || routed != 0 {
		t.Errorf("declining both must read asked=2 routed=0, got %v/%v", asked, routed)
	}
}

// The two tiers hold different cohorts and must not be summed, even though an
// aggregator's answer about a token does not depend on the timing. That
// independence is why the survey asks once instead of twice.
func TestTiersAreKeptApart(t *testing.T) {
	useAgg(t, "sushi")
	s := surveyOf("sushi", map[string]bool{"0xa": true, "0xb": true})
	scoreFromSurvey(config{chain: "robinhood"}, s,
		map[string][]string{"delayed": {"0xa"}, "same_block": {"0xa", "0xb"}},
		map[string]string{})

	if d := testutil.ToFloat64(askedGauge.WithLabelValues(
		"robinhood", "sushi", "delayed", "sushi")); d != 1 {
		t.Errorf("delayed cohort is one token, got %v", d)
	}
	if b := testutil.ToFloat64(askedGauge.WithLabelValues(
		"robinhood", "sushi", "same_block", "sushi-same-block")); b != 2 {
		t.Errorf("same-block cohort is two tokens, got %v", b)
	}
}

// The evidence table lets anyone named on this board check the contracts
// instead of taking a percentage on trust, so it names what was routed into
// and nothing else. A declined token must leave no trace, or the table would
// list the one thing the aggregator got right.
func TestEvidenceNamesOnlyWhatWasRoutedInto(t *testing.T) {
	useAgg(t, "sushi")
	s := surveyOf("sushi", map[string]bool{"0xa": true, "0xb": false})
	scoreFromSurvey(config{chain: "robinhood"}, s,
		map[string][]string{"delayed": {"0xa", "0xb"}},
		map[string]string{"0xa": "AAA", "0xb": "BBB"})

	if n := testutil.CollectAndCount(routedTokenGauge); n != 1 {
		t.Fatalf("only the routed token is evidence, got %d series", n)
	}
	// scoringRule is part of the label set, not decoration: a 24h window must
	// not be able to see samples taken under a different rule, which is how
	// the removed exit floor kept condemning seven tokens for another day.
	if got := testutil.ToFloat64(routedTokenGauge.WithLabelValues(
		"robinhood", "sushi", "delayed", "sushi", "0xa", "AAA",
		scoringRule)); got != 1 {
		t.Errorf("the routed token must be named with its symbol, got %v", got)
	}
}

// Coverage is the denominator the old code never collected: how much of the
// WHOLE examined cohort an aggregator was willing to quote, not just of the
// part whose sale failed. Without it no rate over the cohort can be computed.
func TestCoverageCountsTheWholeExaminedCohort(t *testing.T) {
	useAgg(t, "paraswap")
	s := surveyOf("paraswap",
		map[string]bool{"0xa": true, "0xb": false, "0xc": true}, "0xd")
	publishCoverage(config{chain: "robinhood"}, s, []string{"0xa", "0xb", "0xc", "0xd"})

	// Written under both row slugs, because a panel joins on the row and a
	// row exists per tier, while coverage does not depend on the timing.
	for tier, row := range map[string]string{
		"delayed": "paraswap", "same_block": "paraswap-same-block",
	} {
		if n := testutil.ToFloat64(surveyedGauge.WithLabelValues(
			"robinhood", "paraswap", tier, row)); n != 3 {
			t.Errorf("%s: the unanswered token is not surveyed, got %v", tier, n)
		}
		if n := testutil.ToFloat64(quotedGauge.WithLabelValues(
			"robinhood", "paraswap", tier, row)); n != 2 {
			t.Errorf("%s: two were quoted, got %v", tier, n)
		}
	}
}

// An aggregator that answered nothing publishes no coverage either, for the
// same reason it publishes no score: a zero denominator is not a measurement.
func TestCoveragePublishesNothingWhenNothingAnswered(t *testing.T) {
	useAgg(t, "trnch")
	s := surveyOf("trnch", nil, "0xa", "0xb")
	publishCoverage(config{chain: "robinhood"}, s, []string{"0xa", "0xb"})

	if n := testutil.CollectAndCount(surveyedGauge); n != 0 {
		t.Errorf("nothing answered must publish nothing, got %d series", n)
	}
}

// The board matches a panel value to a row by a label equal to the row slug,
// and a tier partitions providers so one vendor holds two slugs. If this
// drifts from the spec, a column silently renders empty on one tab, which is
// how it shipped the first time.
func TestTheRowSlugMatchesTheSpecProviderSlugs(t *testing.T) {
	cases := map[[2]string]string{
		{"sushi", "delayed"}:        "sushi",
		{"sushi", "same_block"}:     "sushi-same-block",
		{"kyberswap", "same_block"}: "kyberswap-same-block",
		{"trnch", "same_block"}:     "trnch-same-block",
		{"lifi", "delayed"}:         "lifi",
	}
	for in, want := range cases {
		if got := rowSlug(in[0], in[1]); got != want {
			t.Errorf("rowSlug(%q, %q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}
