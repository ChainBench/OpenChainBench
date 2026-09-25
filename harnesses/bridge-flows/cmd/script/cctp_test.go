package main

import (
	"strings"
	"testing"
)

// The v1 topic was observed on-chain (52 events in six hours on Ethereum,
// 2026-09-25); the keccak of the documented signature must match it.
func TestTopicV1MatchesChain(t *testing.T) {
	const observed = "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0"
	if topicV1 != observed {
		t.Fatalf("topicV1 = %s, want %s", topicV1, observed)
	}
	if topicV2 == topicV1 || len(topicV2) != 66 {
		t.Fatalf("topicV2 malformed: %s", topicV2)
	}
}

func pad(addr string) string {
	a := strings.TrimPrefix(strings.ToLower(addr), "0x")
	return "0x" + strings.Repeat("0", 64-len(a)) + a
}

func word(n uint64) string {
	h := strings.ToLower(strings.TrimPrefix(strings.ToUpper(hexU(n)), "0X"))
	return strings.Repeat("0", 64-len(h)) + h
}

func hexU(n uint64) string {
	const digits = "0123456789abcdef"
	if n == 0 {
		return "0x0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{digits[n%16]}, b...)
		n /= 16
	}
	return "0x" + string(b)
}

func TestDecodeBurnV1AndV2(t *testing.T) {
	usdc := "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
	// v1: amount 1,234.567890 USDC to domain 6 (Base)
	v1 := ethLog{
		Topics:      []string{topicV1, word(42), pad(usdc), pad("0x1111111111111111111111111111111111111111")},
		Data:        "0x" + word(1234567890) + word(0) + word(6) + word(0) + word(0),
		BlockNumber: "0x10",
	}
	b, ok := decodeBurn(v1, usdc)
	if !ok || b.version != 1 || b.dest != 6 || b.amountUSD != 1234.56789 || b.block != 16 {
		t.Fatalf("v1 decode: %+v ok=%v", b, ok)
	}
	// v2: amount 5 USDC to domain 5 (Solana); burnToken is topics[1]
	v2 := ethLog{
		Topics:      []string{topicV2, pad(usdc), pad("0x2222222222222222222222222222222222222222"), word(2000)},
		Data:        "0x" + word(5000000) + word(0) + word(5) + word(0) + word(0) + word(0) + word(0) + word(0),
		BlockNumber: "0x20",
	}
	b, ok = decodeBurn(v2, usdc)
	if !ok || b.version != 2 || b.dest != 5 || b.amountUSD != 5 {
		t.Fatalf("v2 decode: %+v ok=%v", b, ok)
	}
	// EURC burn on the same contract is ignored.
	eurc := v2
	eurc.Topics[1] = pad("0x1abaea1f7c830bd89acc67ec4af516284b1bc33c")
	if _, ok := decodeBurn(eurc, usdc); ok {
		t.Fatalf("EURC burn must not count")
	}
	// Removed (reorged) log is ignored.
	rem := v1
	rem.Removed = true
	if _, ok := decodeBurn(rem, usdc); ok {
		t.Fatalf("removed log must not count")
	}
}

func TestStateWindowAndPrune(t *testing.T) {
	s := &State{Version: 1, Chains: map[string]*chainState{}}
	now := nowUnix()
	s.add("base", now-3600, 5, 100)
	s.add("base", now-3600, 5, 50)
	s.add("base", now-3*86400, 0, 7)
	s.add("base", now-9*86400, 0, 999)
	usd, burns := s.window("base", 24*3600e9)
	if usd[5] != 150 || burns[5] != 2 || usd[0] != 0 {
		t.Fatalf("24h window: %v %v", usd, burns)
	}
	usd, _ = s.window("base", 7*24*3600e9)
	if usd[0] != 7 || usd[5] != 150 {
		t.Fatalf("7d window: %v", usd)
	}
	s.prune("base", 8*24)
	usd, _ = s.window("base", 30*24*3600e9)
	if usd[0] != 7 {
		t.Fatalf("prune kept the 9-day bucket: %v", usd)
	}
}
