package main

import "testing"

func TestAccurateLabel(t *testing.T) {
	cases := []struct {
		hint, label string
		want        bool
		why         string
	}{
		{"Binance 14", "Binance", true, "curated entity with an index, provider returns the bare name"},
		{"Uniswap V3 Router 2", "Uniswap: Universal Router", true, "same protocol, different punctuation"},
		{"vitalik.eth", "vitalik.eth", true, "exact"},
		{"OKX 1", "Bittrex 3", false, "different exchange must not pass"},
		{"OKX 1", "OKX 7", true, "same entity, different hot wallet index"},
		{"Bitfinex", "Polygon", false, "unrelated"},
		{"Permit2", "dex.davywoodfi.eth", false, "personal ENS on a known contract"},
		{"USDC (Base native)", "jakie.base.eth", false, "personal basename on a token contract"},
		{"Raydium Authority", "bonklanatoken.sol", false, "personal .sol on a program authority"},
		{"USDT (BSC)", "Fake_Phishing6512", false, "explorer warning tag is not the entity"},
		{"Binance 14", "", false, "no label"},
		{"", "Binance", false, "no hint"},
		{"Binance 8", "Binance 8", true, "exact with index"},
		{"Coinbase 1", "Coinbase 10", true, "same entity"},
	}
	for _, c := range cases {
		if got := accurateLabel(c.hint, c.label); got != c.want {
			t.Errorf("accurateLabel(%q, %q) = %v, want %v (%s)", c.hint, c.label, got, c.want, c.why)
		}
	}
}

func TestHintTokensDropsIndices(t *testing.T) {
	got := hintTokens("Binance 14")
	if len(got) != 1 || got[0] != "binance" {
		t.Fatalf("hintTokens(\"Binance 14\") = %v, want [binance]; a bare index must never be a match token", got)
	}
}
