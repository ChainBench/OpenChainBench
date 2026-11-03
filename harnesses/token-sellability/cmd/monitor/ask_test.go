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

func (f fakeAgg) WillQuote(_ context.Context, token, _ string) (bool, error) {
	if e, ok := f.errs[token]; ok {
		return false, e
	}
	return f.answers[token], nil
}

func run(t *testing.T, agg Aggregator, failed map[string][]string) {
	t.Helper()
	askedGauge.Reset()
	routedGauge.Reset()
	old := aggregatorsForTest
	aggregatorsForTest = []Aggregator{agg}
	t.Cleanup(func() { aggregatorsForTest = old })
	askAggregators(context.Background(), config{chain: "robinhood", ethIn: "1"}, failed)
}

// asked is the denominator, so an aggregator that times out on a token and
// is still counted as having been asked gets a quietly better score. The
// best score here is "never routes into a token you cannot exit", and that
// has to be earned by answering and declining.
func TestATimeoutDoesNotCountAsAsked(t *testing.T) {
	agg := fakeAgg{
		slug:    "sushi",
		answers: map[string]bool{"0xa": true},
		errs:    map[string]error{"0xb": errors.New("timeout")},
	}
	run(t, agg, map[string][]string{"delayed": {"0xa", "0xb"}})

	asked := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "sushi", "delayed"))
	routed := testutil.ToFloat64(routedGauge.WithLabelValues("robinhood", "sushi", "delayed"))
	if asked != 1 {
		t.Errorf("only the answered token counts as asked, got %v", asked)
	}
	if routed != 1 {
		t.Errorf("routed should be 1, got %v", routed)
	}
}

// Every request failing means nothing was established. Publishing a zero
// would put the aggregator at the top of the board for being unreachable.
func TestNothingAnsweredPublishesNothing(t *testing.T) {
	agg := fakeAgg{
		slug: "lifi",
		errs: map[string]error{"0xa": errors.New("down"), "0xb": errors.New("down")},
	}
	run(t, agg, map[string][]string{"delayed": {"0xa", "0xb"}})

	if n := testutil.CollectAndCount(askedGauge); n != 0 {
		t.Errorf("an aggregator that answered nothing must publish nothing, got %d series", n)
	}
	if n := testutil.CollectAndCount(routedGauge); n != 0 {
		t.Errorf("routed must be absent too, got %d series", n)
	}
}

// Declining every token is the best possible record and must be published,
// not confused with the case above.
func TestDecliningEverythingIsRecorded(t *testing.T) {
	agg := fakeAgg{slug: "kyberswap", answers: map[string]bool{"0xa": false, "0xb": false}}
	run(t, agg, map[string][]string{"delayed": {"0xa", "0xb"}})

	asked := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "kyberswap", "delayed"))
	routed := testutil.ToFloat64(routedGauge.WithLabelValues("robinhood", "kyberswap", "delayed"))
	if asked != 2 || routed != 0 {
		t.Errorf("declining both must read asked=2 routed=0, got %v/%v", asked, routed)
	}
}

func TestTimingsAreKeptApart(t *testing.T) {
	agg := fakeAgg{slug: "sushi", answers: map[string]bool{"0xa": true, "0xb": true}}
	run(t, agg, map[string][]string{"delayed": {"0xa"}, "same_block": {"0xa", "0xb"}})

	if d := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "sushi", "delayed")); d != 1 {
		t.Errorf("delayed cohort is one token, got %v", d)
	}
	if s := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "sushi", "same_block")); s != 2 {
		t.Errorf("same-block cohort is two tokens, got %v", s)
	}
}
