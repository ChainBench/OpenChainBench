package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
)

// The encoder is hand-rolled, and the failure mode of hand-rolling nested ABI
// is not a crash: a wrong offset decodes to a well-formed EMPTY array, the
// node answers 200 with a short result, and the probe publishes a latency for
// a call that did no work. "It returned 200" therefore proves nothing here.
//
// So the payload was built in a scratch script, sent to three live chains, and
// its REPLY decoded and checked against individual eth_getBalance reads of the
// same addresses: 3 of 3 matched on ethereum (including a non-zero balance of
// 17004302510961195 wei), base (200000000000) and arc. These digests pin this
// encoder to that verified payload byte for byte, so a change to the encoding
// has to be deliberate and re-verified rather than merely compile.
func TestEncoderMatchesTheLiveVerifiedPayload(t *testing.T) {
	for _, tc := range []struct {
		n      int
		bytes  int
		sha256 string
	}{
		{1, 292, "d24d906245970a843cf5ae8114ec1925c8e61c5f94d94e6a13dd2d676d9fb4a5"},
		{50, 11268, "272d7ceb1d9f3c3ec8976a39b209216250b1b16f4a90bc737751cdd1211a201b"},
	} {
		t.Run(fmt.Sprintf("n=%d", tc.n), func(t *testing.T) {
			data := encodeAggregate3(tc.n)
			raw, err := hex.DecodeString(strings.TrimPrefix(data, "0x"))
			if err != nil {
				t.Fatalf("calldata is not hex: %v", err)
			}
			if len(raw) != tc.bytes {
				t.Fatalf("calldata %d bytes, want %d", len(raw), tc.bytes)
			}
			if got := hex.EncodeToString(sha256Sum(raw)); got != tc.sha256 {
				t.Fatalf("calldata digest %s, want %s (encoding changed: re-verify against live eth_getBalance before updating this)", got, tc.sha256)
			}
		})
	}
}

func sha256Sum(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:]
}

func TestProbeAddressesAreDistinct(t *testing.T) {
	// Distinct is the whole mechanism: N lookups of the same address is one
	// trie descent and N cache hits, which measures nothing about the node.
	seen := map[string]bool{}
	for i := 0; i < heavyCallSubCalls; i++ {
		a := heavyCallAddr(i)
		if len(a) != 40 {
			t.Fatalf("address %d is %q, want 40 hex chars", i, a)
		}
		if seen[a] {
			t.Fatalf("address %d (%s) repeats: the heavy call would be one lookup and %d cache hits", i, a, heavyCallSubCalls-1)
		}
		seen[a] = true
	}
}

func TestServedRequiresTheFullReply(t *testing.T) {
	v := aggregate3Verdict(1)
	full := "0x" + strings.Repeat("ab", aggregate3ResultBytes(1))
	got, err := v([]byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"result":"%s"}`, full)))
	if err != nil || got != verdictServed {
		t.Fatalf("full-size reply gave (%q, %v), want served", got, err)
	}
}

func TestEmptyReplyReachesNoVerdict(t *testing.T) {
	// eth_call against an address with NO CODE succeeds and returns "0x".
	// Multicall3 is deployed on all eight chains today (measured 2026-10-30,
	// identical 3808-byte runtime), but a probe may not assume that: if it
	// ever is not, the honest answer is that we learned nothing about the
	// provider's eth_call, not that the provider refuses it.
	v := aggregate3Verdict(50)
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":1,"result":"0x"}`,
		`{"jsonrpc":"2.0","id":1,"result":"0xabcdef"}`,
	} {
		got, err := v([]byte(body))
		if err == nil {
			t.Fatalf("short reply gave verdict %q, want no verdict: a truncated aggregate3 means multicall3 is missing, which is not a statement about the provider", got)
		}
		if got == verdictUnsupported || got == verdictForbidden {
			t.Fatalf("short reply published a refusal (%q) we never received", got)
		}
	}
}

func TestRefusalsAreStillClassified(t *testing.T) {
	// Withholding a latency must not withhold the capability verdict. Both
	// messages are measured: meowrpc answers the first on a public endpoint,
	// and the plan family is what a keyed provider sends.
	v := aggregate3Verdict(50)
	for _, tc := range []struct {
		name, body, want string
	}{
		{
			"method not supported, measured on meowrpc",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"The method eth_call is not supported"}}`,
			verdictUnsupported,
		},
		{
			"not whitelisted, measured on flashbots",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"rpc method is not whitelisted"}}`,
			verdictUnsupported,
		},
		{
			"withheld from the plan",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"eth_call is not included in your plan"}}`,
			verdictForbidden,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := v([]byte(tc.body))
			if err != nil || got != tc.want {
				t.Fatalf("got (%q, %v), want %q", got, err, tc.want)
			}
		})
	}
}

func TestBothLegsAreProbedAndAdjacent(t *testing.T) {
	// The heavy number alone answers a different question than the review
	// asked: measured from a laptop, 50 extra lookups cost publicnode 23 ms
	// while publicnode and drpc differ by 95 ms at every size, so an absolute
	// heavy latency ranks network position. The pair is the measurement, and
	// the difference is only the work if both legs ran in the same conditions,
	// which means adjacent in the pass.
	var light, heavy = -1, -1
	for i, pr := range coverageProbes {
		switch pr.API {
		case "eth_call_light":
			light = i
		case "eth_call_heavy":
			heavy = i
		}
	}
	if light < 0 || heavy < 0 {
		t.Fatalf("both legs must be probed, found light=%d heavy=%d", light, heavy)
	}
	if heavy-light != 1 {
		t.Fatalf("legs are %d probes apart; they must be adjacent so they share the same network conditions", heavy-light)
	}
}

func TestHeavyLegIsActuallyHeavier(t *testing.T) {
	// A guard against the two constants drifting to the same value, which
	// would leave two identically-priced calls and a difference of noise
	// published as the work.
	if heavyCallSubCalls <= lightCallSubCalls {
		t.Fatalf("heavy=%d light=%d: the pair only means something if one is dearer", heavyCallSubCalls, lightCallSubCalls)
	}
	lightLen := len(encodeAggregate3(lightCallSubCalls))
	heavyLen := len(encodeAggregate3(heavyCallSubCalls))
	if heavyLen <= lightLen {
		t.Fatalf("heavy calldata %d is not larger than light %d", heavyLen, lightLen)
	}
}
