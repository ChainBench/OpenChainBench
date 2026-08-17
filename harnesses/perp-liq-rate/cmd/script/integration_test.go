//go:build integration

package main

import (
	"testing"
)

func TestIntegration_Hyperliquid(t *testing.T) {
	t.Skip("requires -tags integration")
	h := NewHyperliquid()
	oi, err := h.FetchOI("ETH")
	if err != nil {
		t.Fatalf("Hyperliquid FetchOI: %v", err)
	}
	if oi <= 0 {
		t.Errorf("expected positive OI, got %v", oi)
	}
	t.Logf("Hyperliquid ETH OI = %.2f", oi)
}

func TestIntegration_Dydx(t *testing.T) {
	t.Skip("requires -tags integration")
	d := NewDydx()
	oi, err := d.FetchOI("ETH")
	if err != nil {
		t.Fatalf("dYdX FetchOI: %v", err)
	}
	if oi <= 0 {
		t.Errorf("expected positive OI, got %v", oi)
	}
	t.Logf("dYdX ETH OI = %.2f", oi)
}

func TestIntegration_GMX(t *testing.T) {
	t.Skip("requires -tags integration")
	g := NewGMX()
	markets, err := g.fetchMarkets()
	if err != nil {
		t.Fatalf("GMX fetchMarkets: %v", err)
	}
	found := false
	for _, m := range markets {
		if gmxAssetMatches(m.Name, "ETH") {
			found = true
			break
		}
	}
	if !found {
		t.Error("no ETH market found in GMX /markets")
	}
	t.Logf("GMX markets fetched: %d total", len(markets))
}
