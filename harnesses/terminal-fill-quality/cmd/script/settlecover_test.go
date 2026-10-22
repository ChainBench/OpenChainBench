package main

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// A settlement is published under a label the panel can render, so the product
// must equal a provider slug exactly: a row published as "basedbot-funding"
// would exist in Prometheus and be invisible on the page, the way
// lane="bridge" hid 180,682 trades.
//
// And the CHAIN must be the one the slug declares. openchainbench-07 caught
// the funding rows being filed under their destination chain, which put a
// transfer to BNB in the BNB trade column and left the funding view empty.
// "funding" is a productChains value for exactly this reason.
func TestSettleRouteIsAProviderSlugAndItsOwnChain(t *testing.T) {
	for in, want := range map[string][2]string{
		"fomo":             {"fomo", "solana"},
		"fomo-funding":     {"fomo", "funding"},
		"basedbot-funding": {"basedbot", "funding"},
		"phantom-bnb":      {"phantom", "bnb"},
		"pump-fun-base":    {"pump-fun", "base"},
		"pump-bridge-bnb":  {"pump-bridge", "bnb"},
		"fomo-robinhood":   {"fomo", "robinhood"},
	} {
		p, c := settleRoute(in)
		if p != want[0] || c != want[1] {
			t.Fatalf("settleRoute(%q) = (%q, %q), want (%q, %q)", in, p, c, want[0], want[1])
		}
		if _, ok := productNames[p]; !ok {
			t.Fatalf("settleRoute(%q) product %q is not a product the bench publishes", in, p)
		}
	}
}

// The thing openchainbench-e9 overturned: a route's wallet-funding transfers
// must never pool into its bridged-trade figure.
//
// They are the same quantity at both ends, which is what persuaded me to pool
// them, but the published figure is a per-route MEAN and the routes have
// different mixes (BasedBot all funding, Pump Bridge all trades). Pooled, a
// route's number would move with its own composition and a comparison between
// two routes would partly be a comparison of what their legs are.
//
// Here one route gets a fast trade leg and a slow transfer. If the two pooled,
// neither published mean would equal either input.
func TestTradeAndFundingNeverPool(t *testing.T) {
	resetSettle(t)
	for i := 0; i < pumpSettleMin; i++ {
		noteSettle("fomo", settleTrade, "base", 1)
		noteSettle("fomo", settleFunding, "base", 9)
	}
	if v := gaugeAt(t, gSettleMs, "fomo", settleTrade, "base", "mean"); v != 1000 {
		t.Fatalf("trade mean = %v ms, want 1000: the transfers leaked in", v)
	}
	if v := gaugeAt(t, gSettleMs, "fomo", settleFunding, "base", "mean"); v != 9000 {
		t.Fatalf("funding mean = %v ms, want 9000: the trades leaked in", v)
	}
	// And the pooled-chain series pools chains, never kinds.
	if v := gaugeAt(t, gSettleMs, "fomo", settleTrade, "all", "mean"); v != 1000 {
		t.Fatalf("pooled trade mean = %v ms, want 1000", v)
	}
}

// The sample count must survive the quantile floor. Below ten settlements no
// quantile is published, and if the count were gated the same way a thin route
// and an unmeasured route would be the same absent series: the reader could
// not tell "it works, we have three" from "we never looked".
func TestSettleCountPublishesBelowTheQuantileFloor(t *testing.T) {
	resetSettle(t)
	noteSettle("phantom", settleTrade, "bnb", 1)
	noteSettle("phantom", settleTrade, "bnb", 2)

	if n := gaugeAt(t, gSettleN, "phantom", settleTrade, "bnb"); n != 2 {
		t.Fatalf("tfq_settle_samples = %v, want 2 below the floor", n)
	}
	if _, ok := gaugeIfSet(t, gSettleMs, "phantom", settleTrade, "bnb", "median"); ok {
		t.Fatal("a median was published from 2 samples; the floor is 10")
	}
}

// And the count has to be the base of the quantile, not a parallel counter
// that can drift: once the floor is cleared both describe the same window.
func TestSettleCountIsTheBaseOfTheQuantile(t *testing.T) {
	resetSettle(t)
	for i := 0; i < pumpSettleMin; i++ {
		noteSettle("phantom", settleTrade, "base", 1)
	}
	if n := gaugeAt(t, gSettleN, "phantom", settleTrade, "base"); int(n) != pumpSettleMin {
		t.Fatalf("per-chain count = %v, want %d", n, pumpSettleMin)
	}
	if n := gaugeAt(t, gSettleN, "phantom", settleTrade, "all"); int(n) != pumpSettleMin {
		t.Fatalf("pooled count = %v, want %d", n, pumpSettleMin)
	}
	if v, ok := gaugeIfSet(t, gSettleMs, "phantom", settleTrade, "base", "median"); !ok || v != 1000 {
		t.Fatalf("median = %v (set %v), want 1000 ms once the floor is cleared", v, ok)
	}
}

// A stall never enters the window, so it must not inflate the count either:
// the count is what the published figure rests on, and the published figure
// excludes anything past 60 s.
func TestSettleCountExcludesWhatTheFigureExcludes(t *testing.T) {
	resetSettle(t)
	noteSettle("phantom", settleTrade, "arc", 1)
	noteSettle("phantom", settleTrade, "arc", 120)
	if n := gaugeAt(t, gSettleN, "phantom", settleTrade, "arc"); n != 1 {
		t.Fatalf("count = %v, want 1: the 120 s settlement is outside the figure", n)
	}
}

// An unlabelled leg is dropped rather than filed under an empty kind, which
// would be a third population no panel reads.
func TestSettleRefusesAnUnlabelledLeg(t *testing.T) {
	resetSettle(t)
	for i := 0; i < pumpSettleMin; i++ {
		noteSettle("phantom", "", "base", 1)
	}
	if _, ok := gaugeIfSet(t, gSettleN, "phantom", "", "base"); ok {
		t.Fatal("a settlement was recorded with no leg kind")
	}
}

func resetSettle(t *testing.T) {
	t.Helper()
	pumpSettleWindow.Lock()
	pumpSettleWindow.by = nil
	pumpSettleWindow.Unlock()
	gSettleN.Reset()
	gSettleMs.Reset()
}

func gaugeAt(t *testing.T, g *prometheus.GaugeVec, labels ...string) float64 {
	t.Helper()
	v, ok := gaugeIfSet(t, g, labels...)
	if !ok {
		t.Fatalf("no sample at %s", strings.Join(labels, "/"))
	}
	return v
}

func gaugeIfSet(t *testing.T, g *prometheus.GaugeVec, labels ...string) (float64, bool) {
	t.Helper()
	m, err := g.GetMetricWithLabelValues(labels...)
	if err != nil {
		t.Fatalf("labels %v: %v", labels, err)
	}
	var out dto.Metric
	if err := m.Write(&out); err != nil {
		t.Fatalf("write: %v", err)
	}
	// GetMetricWithLabelValues creates the child at zero, so a zero gauge
	// cannot be distinguished from an unset one here. Every value this test
	// asserts on is non-zero by construction.
	if out.GetGauge().GetValue() == 0 {
		return 0, false
	}
	return out.GetGauge().GetValue(), true
}
