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
var getLogsRungs = []uint64{2_000, 10_000, 100_000, 1_000_000}

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
				labelProbe(e, "getlogs_range_"+sh.Shape, classified)
				return false, false
			}
			v, verr := coverageProbes0EmptyOK(raw)
			if verr != nil {
				labelProbe(e, "getlogs_range_"+sh.Shape, "unclassified")
				return false, false
			}
			// A refusal here is about the RANGE, not about the method: the
			// same filter shape at five blocks is what the capability column
			// already answers, so a provider that serves the shape and
			// refuses the width has stated its guard.
			return v == verdictServed, true
		})
		if !out.publish {
			continue
		}
		rpcGetLogsMaxRange.WithLabelValues(
			e.Provider, e.Chain, sh.Shape, currentRegion, tierKeyed).
			Set(float64(out.best))
		labelProbe(e, "getlogs_range_"+sh.Shape, "ok")
	}
}
