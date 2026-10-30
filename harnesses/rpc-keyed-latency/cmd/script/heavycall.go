package main

// heavycall.go — the compute-bound eth_call, and the light call it is only
// meaningful against.
//
// An engineer reviewing the private RPC report asked for a heavy eth_call,
// because it "depends on hardware capacity" and a few expensive calls show
// real differences better than many light ones. The premise is right and the
// obvious implementation would have published something misleading, so both
// halves of that are written down here.
//
// WHAT WAS MEASURED BEFORE WRITING THIS (2026-10-30, from a laptop over the
// public internet, three repeats per cell, new connection per call):
//
//	N sub-calls   calldata   publicnode   drpc
//	    1          0.3 KB      117 ms     206 ms
//	   10          2.3 KB      116        217
//	   50         11.0 KB      140        224
//	  150         32.9 KB      152        244
//
// The work term is real and monotone, and it is SMALL next to the gap between
// two providers: 150 lookups cost publicnode 35 ms more than one lookup, while
// publicnode and drpc differ by about 95 ms at every size. Published as an
// absolute, a heavy call would therefore rank network position, which is what
// the tip probe already ranks, and would answer the review's question with a
// number that mostly is not about hardware.
//
// So the heavy call ships WITH a light reference call in the same pass,
// back to back, on the same cold transport. Both legs pay the same DNS, TCP,
// TLS and round trip, so the difference between them is the work, and the
// subtraction happens between two readings taken seconds apart rather than
// between two metrics on different cadences. The two are published as two
// `api` values on the one latency gauge for exactly that reason.
//
// N = 50 rather than 150: the step from 50 to 150 buys 11 ms of signal for
// three times the request body, and a 33 KB request starts measuring upload.
// Flashbots is the illustration, from the same sweep: it REFUSES eth_call,
// and its refusal went from 345 ms to 547 ms as the payload grew. A refusal's
// latency tracks the size of the message, not the work, which is the second
// reason this file never publishes one.
//
// WHY MULTICALL3. The call has to be identical on every chain to be
// comparable, and nothing can be deployed. Multicall3 sits at the same
// address on all eight keyed chains, verified rather than assumed on
// 2026-10-30: eth_getCode returned the identical 3808-byte runtime on
// ethereum, base, arbitrum, polygon, bnb, robinhood, hyperliquid and arc.
//
// WHY DISTINCT ADDRESSES. Each sub-call is getEthBalance on a different
// address, so each one is a separate descent into the state trie. The work is
// IO and cache bound on the node, which is the property the review is asking
// about, and none of it can be served from a block cache. Most of the
// addresses are empty, which costs a descent all the same: proving absence is
// the same lookup as finding a balance.

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

const (
	// Multicall3, same address on every chain we probe.
	multicall3Addr = "0xcA11bde05977b3631167028862bE2a173976CA11"
	// aggregate3((address,bool,bytes)[])
	selAggregate3 = "82ad56cb"
	// getEthBalance(address)
	selGetEthBalance = "4d2301cc"

	// Sub-calls in the heavy leg. See the sweep above for why not 150.
	heavyCallSubCalls = 50
	// The light leg exists only to carry the same network cost, so it is the
	// smallest well-formed version of the identical call.
	lightCallSubCalls = 1
)

// heavyCallAddr is the i-th probe address: deterministic, distinct, and
// derived rather than famous, so the workload is the same on every chain
// instead of depending on who holds a balance there.
func heavyCallAddr(i int) string {
	base, _ := new(big.Int).SetString("1000000000000000000000000000000000000000", 16)
	base.Add(base, big.NewInt(int64(i)*0x10001))
	return fmt.Sprintf("%040x", base)
}

// encodeAggregate3 builds the calldata for `aggregate3` over n getEthBalance
// sub-calls.
//
// Hand-rolled rather than pulled in with an ABI package: it is one nested
// dynamic array and the harness has no other use for an encoder. The risk of
// hand-rolling is that a wrong offset still decodes to a well-formed empty
// array and the node answers 200, so the test pins this output byte for byte
// against a payload that was verified on live chains by decoding its result
// and matching three of the balances against individual eth_getBalance reads.
func encodeAggregate3(n int) string {
	var inner []string
	for i := 0; i < n; i++ {
		inner = append(inner, selGetEthBalance+word(heavyCallAddr(i)))
	}

	// Each (address,bool,bytes) tuple is itself dynamic, because of `bytes`.
	tuples := make([]string, 0, n)
	for _, cd := range inner {
		nbytes := len(cd) / 2
		tuples = append(tuples,
			word(strings.TrimPrefix(multicall3Addr, "0x"))+ // target
				word("1")+ // allowFailure
				word(fmt.Sprintf("%x", 96))+ // offset to bytes within the tuple
				word(fmt.Sprintf("%x", nbytes))+ // bytes length
				padRight(cd, ((nbytes+31)/32)*64))
	}

	head := make([]string, 0, n)
	running := 32 * n
	for _, t := range tuples {
		head = append(head, word(fmt.Sprintf("%x", running)))
		running += len(t) / 2
	}

	return "0x" + selAggregate3 +
		word(fmt.Sprintf("%x", 32)) + // offset of the single dynamic argument
		word(fmt.Sprintf("%x", n)) + // array length
		strings.Join(head, "") + strings.Join(tuples, "")
}

// aggregate3ResultBytes is the exact size of a well-formed reply: the outer
// offset and length, one offset per element, then each element's success word,
// its bytes offset, its bytes length and one word of balance.
//
// This is the probe's own proof that the work was done. A node with no code at
// the Multicall3 address answers "0x" with no error, which would otherwise
// read as a served eth_call whose latency measured nothing at all. Requiring
// the exact length means the only thing that can be published as served is a
// reply that carries n balances.
func aggregate3ResultBytes(n int) int { return 64 + 160*n }

// aggregate3Verdict is the verdict rule for both legs.
//
// Served requires the full-size reply. A short reply, including the empty one
// from an address with no code, reaches no verdict: it is a fact about the
// chain rather than about the provider's API surface, and bench 311's rule is
// that only a definitive answer about the PROVIDER writes a gauge.
func aggregate3Verdict(n int) func(raw []byte) (string, error) {
	want := aggregate3ResultBytes(n)
	return func(raw []byte) (string, error) {
		var r jsonRPCReply
		if err := json.Unmarshal(raw, &r); err != nil {
			return "", fmt.Errorf("unparseable body: %w", err)
		}
		if r.Error != nil {
			v := classifyError(r.Error.Code, r.Error.Message)
			if v == verdictUnknown {
				return "", fmt.Errorf("unclassified error %d: %s",
					r.Error.Code, truncate(r.Error.Message, 120))
			}
			return v, nil
		}
		var hexResult string
		if err := json.Unmarshal(r.Result, &hexResult); err != nil {
			return "", fmt.Errorf("result not a hex string: %w", err)
		}
		got := (len(strings.TrimPrefix(hexResult, "0x")) + 1) / 2
		if got != want {
			// Deliberately not a refusal. The most likely cause is that
			// Multicall3 is not deployed on this chain any more, which is
			// nothing to do with whether the provider serves eth_call.
			return "", fmt.Errorf(
				"aggregate3 returned %d bytes, want %d: multicall3 missing or truncated reply",
				got, want)
		}
		return verdictServed, nil
	}
}

func ethCallProbe(api string, n int) coverageProbe {
	data := encodeAggregate3(n)
	payload := fmt.Sprintf(
		`{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"%s","data":"%s"},"latest"]}`,
		multicall3Addr, data)
	return coverageProbe{
		API:       api,
		Kind:      "evm",
		body:      func(uint64) (string, bool) { return payload, true },
		supported: aggregate3Verdict(n),
	}
}

// word left-pads a hex string to one 32-byte ABI word.
func word(h string) string {
	h = strings.ToLower(strings.TrimPrefix(h, "0x"))
	if len(h) >= 64 {
		return h[len(h)-64:]
	}
	return strings.Repeat("0", 64-len(h)) + h
}

// padRight right-pads hex to a whole number of words.
func padRight(h string, width int) string {
	if len(h) >= width {
		return h
	}
	return h + strings.Repeat("0", width-len(h))
}
