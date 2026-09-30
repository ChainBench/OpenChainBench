package main

import (
	"testing"

	"gopkg.in/yaml.v3"
)

// null and 0 are opposite claims. A null means the provider publishes no
// price for the method — usually because it does not serve it at all —
// and must make the workload unpriceable. A real 0 means the call is
// genuinely free, which dRPC publishes for eth_chainId and the Solana
// *Unsubscribe methods. Collapsing null to 0 handed PublicNode and
// OnFinality a free debug_traceTransaction, and a free heavy method wins
// a cost leaderboard outright.
func TestNullWeightIsNotZero(t *testing.T) {
	var w Weights
	src := "default: 1\ndebug_traceTransaction: null\neth_chainId: 0\n"
	if err := yaml.Unmarshal([]byte(src), &w); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := w.Weight("debug_traceTransaction"); ok {
		t.Error("a null weight must report unpriced, not a usable 0")
	}
	v, ok := w.Weight("eth_chainId")
	if !ok || v != 0 {
		t.Errorf("an explicit 0 must be a usable free price, got %v %v", v, ok)
	}
	// An unlisted method still falls back to the chain default.
	if v, ok := w.Weight("eth_getBalance"); !ok || v != 1 {
		t.Errorf("unlisted method should fall back to default 1, got %v %v", v, ok)
	}

	// And the whole profile must fail to price rather than costing 0.
	p := Provider{Slug: "publicnode", Weights: map[string]Weights{"ethereum": w}}
	pr := Profile{ID: "trace", Chain: "ethereum", Archive: true,
		Mix: map[string]float64{"debug_traceTransaction": 0.6, "eth_getBlockByNumber": 0.4}}
	if _, err := unitsPerRequest(p, pr); err == nil {
		t.Error("a profile containing an unpriced method must not resolve to a number")
	}
}
