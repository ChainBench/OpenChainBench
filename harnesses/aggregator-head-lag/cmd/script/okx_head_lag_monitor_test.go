package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The arg shape is the whole trick. With flat chainIndex/tokenContractAddress
// keys the gateway answers {"event":"subscribe"} and then pushes nothing for as
// long as you care to wait, which is indistinguishable from a dead channel and
// is exactly how this feed stayed hidden. The params have to be a JSON STRING
// under extraParams, so this pins the encoding rather than the behaviour.
func TestOKXExtraParamsIsANestedJSONString(t *testing.T) {
	got := okxExtraParams("8453", "0x4200000000000000000000000000000000000006")

	// It must be a string that itself parses as an object, not an object.
	var inner map[string]string
	if err := json.Unmarshal([]byte(got), &inner); err != nil {
		t.Fatalf("extraParams must be parseable JSON, got %q: %v", got, err)
	}
	if inner["chainId"] != "8453" {
		t.Errorf("chainId: got %q want 8453", inner["chainId"])
	}
	if inner["tokenContractAddress"] != "0x4200000000000000000000000000000000000006" {
		t.Errorf("token: got %q", inner["tokenContractAddress"])
	}

	// And it must travel as a string once the frame is marshalled, because an
	// object here is the silent-no-data failure.
	frame, err := json.Marshal(map[string]any{
		"op": "subscribe",
		"args": []map[string]string{{
			"channel":     okxChannel,
			"extraParams": got,
		}},
	})
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}
	s := string(frame)
	if !strings.Contains(s, `"extraParams":"{`) {
		t.Errorf("extraParams must serialise as a quoted string, frame was %s", s)
	}
	if strings.Contains(s, `"extraParams":{`) {
		t.Errorf("extraParams serialised as an object, which acks and never pushes: %s", s)
	}
}

// Every chain the monitor subscribes must be one the bench actually publishes,
// and must be measured by an instrument that does not use OKX's own timestamp.
// OKX sends whole seconds, so a chain outside referenceChains and raceChains
// would put a second-quantised clock in a column of millisecond ones.
func TestOKXChainsAvoidTheProviderTimestamp(t *testing.T) {
	for _, c := range okxChains {
		if !referenceChains[c.ChainName] && !raceChains[c.ChainName] {
			t.Errorf("chain %q publishes receiveTime minus the provider's own timestamp, "+
				"and OKX's timestamps are whole seconds; it must not be measured here",
				c.ChainName)
		}
		found := false
		for _, p := range headLagPools {
			if p.ChainName == c.ChainName {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("chain %q is not a bench pool, so no reference exists to match against", c.ChainName)
		}
	}
}

// BNB is a bench pool and OKX supports the chain, so nothing stops someone
// adding it except the reason above. This fails if that happens without BNB
// first gaining a reference or race instrument.
func TestOKXDoesNotCoverBNB(t *testing.T) {
	for _, c := range okxChains {
		if c.ChainName == "bnb" {
			t.Fatal("bnb publishes the provider-timestamp figure; adding OKX there " +
				"publishes its one-second quantisation as latency. Give bnb a " +
				"reference clock first, then revisit.")
		}
	}
}

// A misrouted frame must never be scored on the subscription's chain.
func TestOKXChainNameMapsOKXIndexes(t *testing.T) {
	if got, ok := okxChainName("8453"); !ok || got != "base" {
		t.Errorf("8453: got %q %v want base true", got, ok)
	}
	if got, ok := okxChainName("501"); !ok || got != "solana" {
		t.Errorf("501: got %q %v want solana true", got, ok)
	}
	// 56 is BNB at OKX. We do not measure it, so a frame claiming it must be
	// dropped rather than mapped onto whichever chain we were subscribed to.
	if _, ok := okxChainName("56"); ok {
		t.Error("56 (bnb) must not resolve while OKX is not measured there")
	}
	if _, ok := okxChainName(""); ok {
		t.Error("empty chain index must not resolve")
	}
}

// The timestamp is a string of unix millis. A seconds-precision value, an empty
// field or junk must read as "no timestamp" rather than as 1970, which would
// publish a 56-year lag.
func TestParseOKXMillisRejectsNonMillis(t *testing.T) {
	cases := []struct {
		in   string
		want int64
	}{
		{"1790963535000", 1790963535000},
		{"  1790963535000  ", 1790963535000},
		{"1790963535", 0}, // seconds, not millis
		{"", 0},
		{"null", 0},
		{"abc", 0},
		{"0", 0},
	}
	for _, c := range cases {
		if got := parseOKXMillis(c.in); got != c.want {
			t.Errorf("parseOKXMillis(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

// The feed is undocumented frontend infrastructure. If OKX ever moves it, the
// monitor must fail loudly rather than quietly measure something else, so the
// constants are pinned here: a silent edit to either is what a reader of this
// test is being warned about.
func TestOKXEndpointConstantsArePinned(t *testing.T) {
	if okxWSURL != "wss://wsdexpri.okx.com:443/ws/v5/ipublic" {
		t.Errorf("socket changed to %q. The documented wsdex.okx.com/ws/v6/dex "+
			"requires a paid plan (their fee table: Free = WebSocket not supported), "+
			"so verify the new one is open before shipping.", okxWSURL)
	}
	if okxChannel != "dex-market-trade-history" {
		t.Errorf("channel changed to %q. Note that every `trades`-style name is "+
			"rejected on this path, and the paid v6 channel named `trades` is "+
			"login-gated.", okxChannel)
	}
}

// Exempting a provider from the miss counter is a real loosening, so it must
// stay narrow: the exemption exists only because the subscription cannot be
// scoped to a pool.
func TestOnlyTokenScopedProvidersSkipTheMissCounter(t *testing.T) {
	if !tokenScopedAggregators["okx"] {
		t.Error("okx is token-scoped upstream and must be exempt, or its miss " +
			"counter reads 96% and hides whether the reference is healthy")
	}
	for _, a := range []string{"mobula", "codex", "geckoterminal", "serialized", "reference"} {
		if tokenScopedAggregators[a] {
			t.Errorf("%q subscribes per pool, so an unmatched emission really is a "+
				"miss and must still be counted", a)
		}
	}
}
