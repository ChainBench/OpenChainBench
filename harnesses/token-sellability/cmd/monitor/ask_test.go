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
	errorGauge.Reset()
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

	asked := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "sushi", "delayed", "sushi"))
	routed := testutil.ToFloat64(routedGauge.WithLabelValues("robinhood", "sushi", "delayed", "sushi"))
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

	asked := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "kyberswap", "delayed", "kyberswap"))
	routed := testutil.ToFloat64(routedGauge.WithLabelValues("robinhood", "kyberswap", "delayed", "kyberswap"))
	if asked != 2 || routed != 0 {
		t.Errorf("declining both must read asked=2 routed=0, got %v/%v", asked, routed)
	}
}

func TestTimingsAreKeptApart(t *testing.T) {
	agg := fakeAgg{slug: "sushi", answers: map[string]bool{"0xa": true, "0xb": true}}
	run(t, agg, map[string][]string{"delayed": {"0xa"}, "same_block": {"0xa", "0xb"}})

	if d := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "sushi", "delayed", "sushi")); d != 1 {
		t.Errorf("delayed cohort is one token, got %v", d)
	}
	if s := testutil.ToFloat64(askedGauge.WithLabelValues("robinhood", "sushi", "same_block", "sushi-same-block")); s != 2 {
		t.Errorf("same-block cohort is two tokens, got %v", s)
	}
}

// The one case the board could not previously tell apart from a perfect
// record: every request failed, so nothing was established. asked and routed
// are absent, and the error count is what says why.
func TestAllFailedPublishesTheErrorCount(t *testing.T) {
	agg := fakeAgg{
		slug: "lifi",
		errs: map[string]error{"0xa": errors.New("down"), "0xb": errors.New("down")},
	}
	run(t, agg, map[string][]string{"delayed": {"0xa", "0xb"}})

	if n := testutil.CollectAndCount(askedGauge); n != 0 {
		t.Errorf("asked must stay absent, got %d series", n)
	}
	if e := testutil.ToFloat64(errorGauge.WithLabelValues("robinhood", "lifi", "delayed", "lifi")); e != 2 {
		t.Errorf("both failures must be published, got %v", e)
	}
}

// A clean sweep publishes a zero rather than nothing, so "no errors" and
// "never ran" stay distinguishable on the board.
func TestACleanSweepPublishesZeroErrors(t *testing.T) {
	agg := fakeAgg{slug: "sushi", answers: map[string]bool{"0xa": true}}
	run(t, agg, map[string][]string{"delayed": {"0xa"}})

	if e := testutil.ToFloat64(errorGauge.WithLabelValues("robinhood", "sushi", "delayed", "sushi")); e != 0 {
		t.Errorf("a clean sweep must publish zero, got %v", e)
	}
	if n := testutil.CollectAndCount(errorGauge); n != 1 {
		t.Errorf("exactly one error series, got %d", n)
	}
}

// The board matches a panel value to a row by a label equal to the row
// slug, and a tier partitions providers so one vendor holds two slugs. If
// this mapping drifts from the spec's provider list, the column silently
// renders empty on one tab, which is exactly how it shipped the first time.
func TestTheRowSlugMatchesTheSpecProviderSlugs(t *testing.T) {
	cases := map[[2]string]string{
		{"sushi", "delayed"}:        "sushi",
		{"sushi", "same_block"}:     "sushi-same-block",
		{"kyberswap", "delayed"}:    "kyberswap",
		{"kyberswap", "same_block"}: "kyberswap-same-block",
		{"paraswap", "same_block"}:  "paraswap-same-block",
		{"lifi", "same_block"}:      "lifi-same-block",
	}
	for in, want := range cases {
		if got := rowSlug(in[0], in[1]); got != want {
			t.Errorf("rowSlug(%q, %q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}

// The slug reaches the series, not just the helper. Without this the two
// halves of the fix can pass separately while the column stays empty.
func TestTheProviderLabelReachesTheSeries(t *testing.T) {
	agg := fakeAgg{slug: "sushi", answers: map[string]bool{"0xa": true}}
	run(t, agg, map[string][]string{"same_block": {"0xa"}})

	got := testutil.ToFloat64(
		askedGauge.WithLabelValues("robinhood", "sushi", "same_block", "sushi-same-block"))
	if got != 1 {
		t.Errorf("the same-block series must carry the suffixed slug, got %v", got)
	}
}
