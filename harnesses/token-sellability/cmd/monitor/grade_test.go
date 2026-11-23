package main

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// gradedAgg answers whatever the test tells it to, so the wiring between a
// grade and the series it writes can be driven without a network.
type gradedAgg struct {
	slug string
	by   map[string]Answer
}

func (g gradedAgg) Slug() string { return g.slug }
func (g gradedAgg) WillQuote(_ context.Context, token string, _ int, _ string) (Answer, error) {
	return g.by[token], nil
}

// Grading the answer is half the fix. The other half is that each grade
// reaches its own series, and only a test of the wiring catches both: a
// classification that is right and written to the wrong gauge publishes the
// same wrong board as no classification at all.
func TestEachGradeReachesItsOwnSeries(t *testing.T) {
	for _, g := range []interface{ Reset() }{
		askedGauge, routedGauge, errorGauge, routedTokenGauge, askedTokenGauge,
		screenedTokenGauge, noLiquidityTokenGauge, reservedTokenGauge,
		surveyedGauge, quotedGauge,
	} {
		g.Reset()
	}
	old := aggregatorsForTest
	agg := gradedAgg{slug: "trnch", by: map[string]Answer{
		"0xrouted":   Routed,
		"0xreserved": Reserved,
		"0xscreened": Screened,
		"0xdry":      NoLiquidity,
	}}
	aggregatorsForTest = []Aggregator{agg}
	t.Cleanup(func() { aggregatorsForTest = old })

	toks := []string{"0xrouted", "0xreserved", "0xscreened", "0xdry"}
	s := &Survey{rows: map[string]map[string]surveyRow{}}
	for _, tok := range toks {
		s.set(tok, "trnch", surveyRow{answer: agg.by[tok]})
	}
	scoreFromSurvey(config{chain: "robinhood"}, s,
		map[string][]string{"delayed": toks}, map[string]string{})

	// Count SERIES, not a value: each gauge carries one series per token, so
	// one series is one token and ToFloat64 would refuse a gauge holding
	// more than one.
	for name, got := range map[string]int{
		"routed":       testutil.CollectAndCount(routedTokenGauge),
		"reserved":     testutil.CollectAndCount(reservedTokenGauge),
		"screened":     testutil.CollectAndCount(screenedTokenGauge),
		"no_liquidity": testutil.CollectAndCount(noLiquidityTokenGauge),
	} {
		want := 1
		// routed carries the reservation too, because a reservation does not
		// stop you entering: two tokens, not one.
		if name == "routed" {
			want = 2
		}
		if got != want {
			t.Errorf("%s: %d token series, want %d", name, got, want)
		}
	}

	// And the denominator is every token that answered, whatever it said.
	if n := testutil.CollectAndCount(askedTokenGauge); n != 4 {
		t.Errorf("asked = %d, want 4: a refusal is an answer", n)
	}
}

// Declaring a gauge is not publishing it.
//
// The first deploy of this change wrote all three grades correctly and
// exposed none of them: built with NewGaugeVec, never added to
// MustRegister, so /metrics carried the sixteen old series names and not one
// new one. The wiring test above passed anyway, because CollectAndCount
// reads a collector whether or not anything registered it, which is exactly
// the half of a fix a test can miss.
//
// Asserted on main.go's own list, because that list is the thing that was
// wrong and a registry built here would not notice it.
func TestTheGradesAreActuallyRegistered(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	start := strings.Index(text, "prometheus.MustRegister(")
	if start < 0 {
		t.Fatal("no MustRegister call in main.go")
	}
	rest := text[start:]
	block := rest[:strings.Index(rest, ")")]
	for _, name := range []string{
		"screenedTokenGauge", "noLiquidityTokenGauge", "reservedTokenGauge",
		// The ones the grades sit beside, so a rewrite of this list cannot
		// drop an old series while satisfying the new check.
		"routedTokenGauge", "askedTokenGauge",
	} {
		if !strings.Contains(block, name) {
			t.Errorf("%s is never registered, so it never reaches /metrics", name)
		}
	}
}

// The two refusals are opposite claims about a router, so a table entry that
// forgot its kind would file a decline under neither and quietly empty a
// column. Every entry in every table has to say which one it is.
func TestEveryRefusalNamesTokenOrMarket(t *testing.T) {
	tables := map[string][]refusal{
		"kyberswap": kyberRefusals,
		"paraswap":  paraswapRefusals,
		"trnch":     trnchRefusals,
		"lifi":      lifiRefusals,
	}
	for name, tbl := range tables {
		if len(tbl) == 0 {
			t.Errorf("%s has no refusal table", name)
		}
		for _, r := range tbl {
			if r.kind != Screened && r.kind != NoLiquidity {
				t.Errorf("%s: refusal %q/%d has no kind", name, r.needle, r.code)
			}
		}
	}
}

// Trnch's screen is the one refusal on this board that names the token on
// purpose, and the board exists partly to show it. If this ever reads
// NoLiquidity, the column that credits a router for protecting its caller
// silently empties.
func TestTrnchScreenIsFiledAgainstTheToken(t *testing.T) {
	kind, no := isRefusal([]byte(`{"error":"token not tradable through TRNCH"}`),
		trnchRefusals)
	if !no || kind != Screened {
		t.Errorf("trnch's screen must read as Screened, got %s no=%v", kind, no)
	}
	kind, no = isRefusal([]byte(`{"error":"No routes found with enough liquidity"}`),
		paraswapRefusals)
	if !no || kind != NoLiquidity {
		t.Errorf("an empty market must read as NoLiquidity, got %s no=%v", kind, no)
	}
}
