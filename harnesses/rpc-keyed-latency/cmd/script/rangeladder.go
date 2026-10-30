package main

// rangeladder.go — how wide an eth_getLogs window each provider's range guard
// admits.
//
// rpc_getlogs_max_range_blocks has been declared in metrics.go since bench 311
// shipped, with nothing writing it and no spec reading it. The bench's own
// methodology already promises the measurement and says why the capability
// column is not it: the three filter shapes are asked over five blocks, "a
// narrow window is the question every provider should be able to answer. It is
// not the question an indexer asks."
//
// WHAT THIS MEASURES, precisely, because the obvious name for it would be
// wrong. Measured 2026-10-30 against live keyed endpoints:
//
//	provider     chain     shape     span       ms     outcome
//	alchemy      ethereum  address   1,000,000  209    accepted, 0 logs
//	alchemy      base      topics    1,000,000  219    accepted, 0 logs
//	chainstack   ethereum  address   100,000    102    refused, "Block range limit exceeded"
//	chainstack   ethereum  address    10,000    131    accepted, 0 logs
//
// A million blocks answered in 209 ms is not a scan. The filters here are
// built to match nothing, so a provider with an index returns empty
// immediately and the only thing standing between the request and an empty
// reply is the static guard on toBlock minus fromBlock. That guard is the
// useful quantity: it trips before any work, so it is what freezes an
// indexer's cursor regardless of how much data the window holds. It is NOT the
// widest window from which the provider will actually deliver logs, and the
// gauge's help text says so.
//
// WHY THE FILTERS MATCH NOTHING. A wide unfiltered window is megabytes per
// call, every pass, per provider. The zero address holds no logs, and a topic0
// of 0xee..ee cannot equal any deployed event signature, so both shapes return
// an empty array at any width. Verified at every rung: 0 logs each time.
//
// WHY REAL PAST RANGES. The cheaper idea was to ask for a window above the
// chain head, where a guard would still trip on an empty range. It is invalid:
// dRPC ACCEPTED a range above its head and returned 847 KB of logs for blocks
// that do not exist, so the probe would have published "span accepted" for a
// provider that never evaluated the span. publicnode, meanwhile, refuses a
// future range specifically ("block range extends beyond current"). Two of
// three providers behaved differently from the real thing, so the stand-in is
// gone.
//
// WHAT IS DELIBERATELY NOT LADDERED. The no-filter shape. There is no way to
// bound its reply, so asking it wide means pulling megabytes, and the honest
// answer is to not ask. It keeps its five-block capability column and no range
// number. publicnode shows why that column still earns its place: it refuses a
// topic-only query outright with "Please specify an address in your request",
// so its topic range reads 0 while its address range reads 10,000.
//
// COMPARABILITY. The unit is blocks, and a block is 12 seconds on Ethereum and
// 2 on Base, so 10,000 blocks is 33 hours on one chain and 5.5 on the other.
// Providers are comparable within a chain tab. Across chains they are not, and
// a spec that publishes this must stay per chain.

import (
	"context"
	"encoding/json"
	"fmt"
)

// Rungs ascend, the ladder stops at the first refusal, and the published value
// is the largest rung ACCEPTED. A provider that passes the top rung therefore
// publishes a floor rather than its real limit: Alchemy passes 1,000,000 on
// every chain tested, and a wider rung would mostly measure chain height.
//
// Every rung measured under 1.3 s against live endpoints, comfortably inside
// probeTimeout. That matters more than it looks: a rung slower than our own
// 8 s timeout would be recorded as a timeout, and the published limit would be
// capped by our patience rather than by the provider's guard.
//
// THE BOTTOM THREE RUNGS WERE ADDED AFTER THE FIRST PRODUCTION PASS. The
// ladder started at 2,000 and two providers of five published nothing at all:
// dwellir 0 cells of 16, getblock 2 of 14. Their limits sit below that first
// rung, which their own errors state outright once you read them:
//
//	dwellir   -32005  "eth_getLogs range of 2001 blocks exceeds the 500-block limit"
//	getblock  -32062  "Block range is too large"
//
// A ladder whose first rung is above a provider's limit can only ever publish
// zero for them, and zero does not separate a 500-block limit from a 50-block
// one. Stopping at the first refusal keeps the cheap providers cheap: dwellir
// answers 100, answers 500, is refused at 1,000, and publishes 500 in three
// calls rather than seven.
var getLogsRungs = []uint64{100, 500, 1_000, 2_000, 10_000, 100_000, 1_000_000}

// The two shapes whose reply can be bounded. Names match the filter_shape
// label values the capability columns already use, so a reader can line the
// range up against the boolean for the same shape.
var getLogsRangeShapes = []struct {
	Shape  string
	Filter func(lo, hi uint64) string
}{
	{
		Shape: "address",
		Filter: func(lo, hi uint64) string {
			return fmt.Sprintf(
				`{"fromBlock":"%s","toBlock":"%s","address":"0x0000000000000000000000000000000000000000"}`,
				hexNum(lo), hexNum(hi))
		},
	},
	{
		Shape: "topics",
		Filter: func(lo, hi uint64) string {
			return fmt.Sprintf(
				`{"fromBlock":"%s","toBlock":"%s","topics":["0x%s"]}`,
				hexNum(lo), hexNum(hi), nonexistentTopic)
		},
	},
}

// A 32-byte topic0 no deployed event signature can equal, so the topic index
// is consulted and matches nothing.
const nonexistentTopic = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

// acceptedSpan reads one rung's reply: was the span accepted, and was the
// answer definitive.
//
// This is NOT the capability classifier, and the first production pass is why.
// `classifyError` recognises two families, a method that is absent and a
// method withheld from the plan, and returns "unknown" for everything else so
// a rate-limit message can never be mistaken for evidence about capability.
// That caution is right there and wrong here: a range refusal belongs to
// neither family, so the ladder read every one of them as "we did not find
// out" and published nothing. Dwellir produced zero readings of sixteen and
// getblock two of fourteen, while their replies said plainly:
//
//	-32005  "eth_getLogs range of 2001 blocks exceeds the 500-block limit"
//	-32062  "Block range is too large"
//
// Inside the ladder the ambiguity those two families guard against does not
// exist. Whether the shape is routed at all is the capability column's
// question and it is answered separately, over five blocks. So here a
// JSON-RPC error means the provider declined THIS WIDTH, which is the
// measurement. The only indefinite outcome left is a body we cannot read.
func acceptedSpan(raw []byte) (accepted bool, definitive bool) {
	var r jsonRPCReply
	if err := json.Unmarshal(raw, &r); err != nil {
		return false, false
	}
	if r.Error != nil {
		return false, true
	}
	// An empty array is the expected success: the filters match nothing by
	// design. A result that is absent or not an array is not an answer.
	var logs []json.RawMessage
	if len(r.Result) == 0 {
		return false, false
	}
	if err := json.Unmarshal(r.Result, &logs); err != nil {
		return false, false
	}
	return true, true
}

// rangeOutcome is what one ladder learned.
type rangeOutcome struct {
	// best is the largest rung accepted; 0 means even the first was refused.
	best uint64
	// publish is false when we never got a definitive answer: an HTTP error
	// or a timeout on the first rung is our failure, and bench 311's rule is
	// that only a definitive answer about the PROVIDER writes a gauge.
	publish bool
	// calls spent, for the log line.
	calls int
}

// climb walks the rungs for one shape. Separated from the network so the
// stopping rule is testable: `ask` returns the verdict for one span.
//
// The rule has three endings and they are not interchangeable.
//
//	refused at rung k  -> publish rung k-1 (0 if k is the first). A refusal is
//	                      the provider's guard, which is the measurement.
//	accepted all rungs -> publish the top rung, which is a floor.
//	our failure at k   -> publish rung k-1 only if something was accepted. A
//	                      timeout is not a refusal, and inferring a limit from
//	                      one would publish our own patience as their policy.
func climb(ask func(span uint64) (accepted bool, definitive bool)) rangeOutcome {
	var out rangeOutcome
	for _, span := range getLogsRungs {
		accepted, definitive := ask(span)
		out.calls++
		if !definitive {
			// Our failure. Keep whatever was already established.
			return out
		}
		if !accepted {
			out.publish = true
			return out
		}
		out.best = span
		out.publish = true
	}
	return out
}

// probeGetLogsRange ladders both shapes for one endpoint.
func probeGetLogsRange(ctx context.Context, e Endpoint, head uint64) {
	if e.Kind != "evm" || head == 0 {
		return
	}
	for _, sh := range getLogsRangeShapes {
		out := climb(func(span uint64) (bool, bool) {
			if head <= span {
				// The chain is younger than this rung. Not askable, and not a
				// refusal either.
				return false, false
			}
			if !quota.allow(e.Provider, currentRegion) {
				return false, false
			}
			payload := fmt.Sprintf(
				`{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[%s]}`,
				sh.Filter(head-span, head))
			raw, _, classified, err := doPost(ctx, e.URL, []byte(payload), false)
			if err != nil {
				// An HTTP-level failure is ours to own, not theirs to answer
				// for. One real case is lost here and knowingly: getblock on
				// arc delivers its range refusal as an HTTP 403 whose body
				// says "Requested block range exceeds the limits (1500
				// blocks)", and doPost discards a non-200 body, so that cell
				// publishes nothing rather than a guessed limit.
				labelProbe(e, "getlogs_range_"+sh.Shape, classified)
				return false, false
			}
			return acceptedSpan(raw)
		})
		if !out.publish {
			// Printed, not silent. A ladder that reaches no verdict is
			// indistinguishable from one that never ran, and every other
			// part of this harness was verified today by reading what it
			// printed: the coverage line's probe count is what proved the
			// new binary was deployed, because a green build proves nothing.
			fmt.Printf("[getlogs-range] %-16s %-12s %-8s no verdict after %d call(s)\n",
				e.Provider, e.Chain, sh.Shape, out.calls)
			continue
		}
		rpcGetLogsMaxRange.WithLabelValues(
			e.Provider, e.Chain, sh.Shape, currentRegion, tierKeyed).
			Set(float64(out.best))
		labelProbe(e, "getlogs_range_"+sh.Shape, "ok")
		// The floor case is worth distinguishing in the log, because the
		// published number means something different there: the guard is
		// somewhere above the top rung rather than at it.
		note := ""
		if out.best == getLogsRungs[len(getLogsRungs)-1] {
			note = " (top rung, so a floor)"
		}
		fmt.Printf("[getlogs-range] %-16s %-12s %-8s max %d blocks in %d call(s)%s\n",
			e.Provider, e.Chain, sh.Shape, out.best, out.calls, note)
	}
}
