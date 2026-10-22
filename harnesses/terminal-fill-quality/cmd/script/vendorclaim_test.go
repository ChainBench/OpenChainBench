package main

import (
	"math"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// gaugeVal reads one labelled sample back out of a GaugeVec.
func gaugeVal(t *testing.T, g *prometheus.GaugeVec, labels ...string) float64 {
	t.Helper()
	m := &dto.Metric{}
	if err := g.WithLabelValues(labels...).Write(m); err != nil {
		t.Fatalf("reading %v: %v", labels, err)
	}
	return m.GetGauge().GetValue()
}

// The embedded digest must reproduce the vendor's own headline, and the figure
// its headline leaves out.
//
// This is the whole reason the counts are in the repository rather than a
// sentence about them: anyone can recompute both numbers, and if the digest is
// ever edited these fail.
func TestVendorDigestReproducesBothFigures(t *testing.T) {
	loadVendorAB()

	bridgeBuy := gaugeVal(t, gVendorABErrorRate, "pump-fun", "bridge", "buy")
	relayBuy := gaugeVal(t, gVendorABErrorRate, "pump-fun", "relay", "buy")
	if math.Abs(bridgeBuy-0.869) > 0.002 || math.Abs(relayBuy-11.214) > 0.002 {
		t.Errorf("buys: bridge %.3f%% relay %.3f%%, want 0.869 and 11.214 "+
			"(pump published 0.87 and 11)", bridgeBuy, relayBuy)
	}
	if r := relayBuy / bridgeBuy; math.Abs(r-12.90) > 0.05 {
		t.Errorf("buy ratio %.2fx, want 12.90 (pump said almost 13x)", r)
	}

	bridgeAll := gaugeVal(t, gVendorABErrorRate, "pump-fun", "bridge", "all")
	relayAll := gaugeVal(t, gVendorABErrorRate, "pump-fun", "relay", "all")
	if math.Abs(bridgeAll-3.664) > 0.002 || math.Abs(relayAll-10.817) > 0.002 {
		t.Errorf("both directions: bridge %.3f%% relay %.3f%%, want 3.664 and 10.817",
			bridgeAll, relayAll)
	}
	if r := relayAll / bridgeAll; math.Abs(r-2.95) > 0.02 {
		t.Errorf("overall ratio %.2fx, want 2.95", r)
	}

	// The claim rests on the gap between the two directions, so assert it
	// rather than leave it implied.
	bridgeSell := gaugeVal(t, gVendorABErrorRate, "pump-fun", "bridge", "sell")
	if bridgeSell < bridgeBuy*5 {
		t.Errorf("bridge sells %.3f%% against buys %.3f%%: the direction gap "+
			"that makes the headline selective is not in the digest",
			bridgeSell, bridgeBuy)
	}
}

// Denominators must be published with the rates.
//
// The arms are not equally sized on both directions: buys are matched to 0.6%
// while the bridge carries far fewer sells than Relay. A rate shown without its
// base hides that.
func TestVendorDigestPublishesItsDenominators(t *testing.T) {
	loadVendorAB()
	for _, lane := range []string{"bridge", "relay"} {
		for _, dir := range []string{"buy", "sell", "all"} {
			if n := gaugeVal(t, gVendorABRows, "pump-fun", lane, dir); n <= 0 {
				t.Errorf("%s/%s has no row count", lane, dir)
			}
		}
	}
	bb := gaugeVal(t, gVendorABRows, "pump-fun", "bridge", "buy")
	rb := gaugeVal(t, gVendorABRows, "pump-fun", "relay", "buy")
	if d := math.Abs(bb-rb) / ((bb + rb) / 2); d > 0.02 {
		t.Errorf("buy arms differ by %.1f%%, expected them matched", 100*d)
	}
	bs := gaugeVal(t, gVendorABRows, "pump-fun", "bridge", "sell")
	rs := gaugeVal(t, gVendorABRows, "pump-fun", "relay", "sell")
	if bs >= rs {
		t.Errorf("bridge sells %.0f vs relay %.0f: the arm imbalance this "+
			"documents is gone, so the comment is stale", bs, rs)
	}
}

// The digest must stay auditable: it is evidence only if it names its source.
func TestVendorDigestCarriesItsProvenance(t *testing.T) {
	head := pumpErrorDigest
	if i := strings.Index(head, "chain,lane"); i > 0 {
		head = head[:i]
	}
	for _, want := range []string{"sha256(original)", "original rows 416669",
		"2026-09-28T16", "2026-10-07T20"} {
		if !strings.Contains(head, want) {
			t.Errorf("digest header does not state %q", want)
		}
	}
}
