package main

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// A settlement is published under a label the panel can render, which means it
// must equal a provider slug exactly. The funding rows arrive as
// "<app>-funding", which is not a slug: published raw, BasedBot's settlement
// time would exist in Prometheus and be invisible on the page, the same way
// lane="bridge" hid 180,682 trades.
func TestSettleTerminalIsAProviderSlug(t *testing.T) {
	for in, want := range map[string]string{
		"fomo":             "fomo",
		"fomo-funding":     "fomo",
		"basedbot-funding": "basedbot",
		"phantom-bnb":      "phantom",
		"pump-fun-base":    "pump-fun",
		"pump-bridge-bnb":  "pump-bridge",
		"fomo-robinhood":   "fomo",
	} {
		got := settleTerminal(in)
		if got != want {
			t.Fatalf("settleTerminal(%q) = %q, want %q", in, got, want)
		}
		if _, ok := productNames[got]; !ok {
			t.Fatalf("settleTerminal(%q) = %q, which is not a product the bench publishes", in, got)
		}
	}
}

// The sample count must survive the quantile floor. Below ten settlements no
// quantile is published, and if the count were gated the same way a thin route
// and an unmeasured route would be the same absent series: the reader could
// not tell "it works, we have three" from "we never looked".
func TestSettleCountPublishesBelowTheQuantileFloor(t *testing.T) {
	resetSettle(t)
	noteSettle("phantom", "bnb", 1)
	noteSettle("phantom", "bnb", 2)

	if n := gaugeAt(t, gSettleN, "phantom", "bnb"); n != 2 {
		t.Fatalf("tfq_settle_samples = %v, want 2 below the floor", n)
	}
	if _, ok := gaugeIfSet(t, gSettleMs, "phantom", "bnb", "median"); ok {
		t.Fatal("a median was published from 2 samples; the floor is 10")
	}
}

// And the count has to be the base of the quantile, not a parallel counter
// that can drift: once the floor is cleared both describe the same window.
func TestSettleCountIsTheBaseOfTheQuantile(t *testing.T) {
	resetSettle(t)
	for i := 0; i < pumpSettleMin; i++ {
		noteSettle("phantom", "base", 1)
	}
	if n := gaugeAt(t, gSettleN, "phantom", "base"); int(n) != pumpSettleMin {
		t.Fatalf("per-chain count = %v, want %d", n, pumpSettleMin)
	}
	if n := gaugeAt(t, gSettleN, "phantom", "all"); int(n) != pumpSettleMin {
		t.Fatalf("pooled count = %v, want %d", n, pumpSettleMin)
	}
	if v, ok := gaugeIfSet(t, gSettleMs, "phantom", "base", "median"); !ok || v != 1000 {
		t.Fatalf("median = %v (set %v), want 1000 ms once the floor is cleared", v, ok)
	}
}

// A stall never enters the window, so it must not inflate the count either:
// the count is what the published figure rests on, and the published figure
// excludes anything past 60 s.
func TestSettleCountExcludesWhatTheFigureExcludes(t *testing.T) {
	resetSettle(t)
	noteSettle("phantom", "arc", 1)
	noteSettle("phantom", "arc", 120)
	if n := gaugeAt(t, gSettleN, "phantom", "arc"); n != 1 {
		t.Fatalf("count = %v, want 1: the 120 s settlement is outside the figure", n)
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
