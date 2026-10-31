package main

// passbuffer.go — the exported matrix is the output of ONE complete pass.
//
// THE DEFECT. Capability gauges live in the process, so a restart starts from
// nothing and the first pass fills the matrix cell by cell over about
// seventeen minutes. Anything reading in that window reads a matrix with
// holes, and the holes shrink the denominator rather than announcing
// themselves. Measured 2026-10-30, BlockMachine during the first pass after a
// deploy:
//
//	40 of 42 cells  = 95.24 %   published, Arc missing entirely
//	47 of 49 cells  = 95.92 %   once the pass finished
//
// The board also carried the sentence "BlockMachine at 95.2%", and
// providersPerChain.arc did not list it. Nothing was wrong with any single
// reading; the SET was incomplete, and a share over an incomplete set is a
// different quantity wearing the same name.
//
// WHY NOT A pass_complete GAUGE. It would need a join on sixty-seven spec
// selectors, and it would still leave the mid-pass mixture on later passes.
// Buffering states the invariant once, in the producer, where it is cheap.
//
// WHAT THIS COSTS. After a restart the capability cells publish NOTHING for
// about eighteen minutes instead of publishing a growing fraction. That is
// the right trade for this board: a blank cell is a question we have not
// answered yet, and 95.24 is an answer to a question nobody asked. The
// headline row is carried by the worker at its last correct value meanwhile,
// so the page shows 95.92 with a staleness stamp rather than a wrong number.
//
// WHAT IS NOT BUFFERED. The probe counters (labelProbe) write through: they
// are the witnesses that say what the pass is doing, and hiding them would
// make a stalled pass look like an idle one. The hourly eth_call lane writes
// through too, via directSink: its readings are measurements, not matrix
// cells, and it runs in its own goroutine, so sharing a buffer with the pass
// would be a data race as well as a category error.

import (
	"time"
)

// coverageSink receives what a probe established. A probe never touches a
// gauge itself, so the choice between publishing now and publishing at the
// end of a pass is made by the caller and is visible in its signature.
type coverageSink interface {
	// verdict publishes a capability, its stamp, and the latency when the
	// method was served.
	verdict(e Endpoint, api, verdict string, latencyMs float64, at time.Time)
	// rangeBound publishes one shape's widest accepted window.
	rangeBound(e Endpoint, shape, bound string, blocks float64)
}

// directSink publishes immediately.
type directSink struct{}

func (directSink) verdict(e Endpoint, api, v string, latencyMs float64, at time.Time) {
	switch v {
	case verdictServed:
		setCoverage(e, api, 1, at)
		rpcAPILatency.WithLabelValues(
			e.Provider, e.Chain, api, currentRegion, tierKeyed).Set(latencyMs)
	case verdictUnsupported, verdictForbidden:
		setCoverage(e, api, 0, at)
	}
}

func (directSink) rangeBound(e Endpoint, shape, bound string, blocks float64) {
	rpcGetLogsMaxRange.WithLabelValues(
		e.Provider, e.Chain, shape, bound, currentRegion, tierKeyed).Set(blocks)
}

type bufferedVerdict struct {
	e         Endpoint
	api       string
	verdict   string
	latencyMs float64
	at        time.Time
}

type bufferedBound struct {
	e      Endpoint
	shape  string
	bound  string
	blocks float64
}

// passBuffer holds a whole pass and publishes it in one step.
//
// Not safe for concurrent use, and it does not need to be: one pass runs at a
// time, sequentially, in one goroutine. The hourly lane has its own sink.
type passBuffer struct {
	verdicts []bufferedVerdict
	bounds   []bufferedBound
}

func (b *passBuffer) verdict(e Endpoint, api, v string, latencyMs float64, at time.Time) {
	b.verdicts = append(b.verdicts, bufferedVerdict{e, api, v, latencyMs, at})
}

func (b *passBuffer) rangeBound(e Endpoint, shape, bound string, blocks float64) {
	b.bounds = append(b.bounds, bufferedBound{e, shape, bound, blocks})
}

// flush publishes everything the pass established.
//
// The stamp travels with each verdict rather than being taken here. Taking it
// here would date every cell to the end of the pass, which would make
// `time() - rpc_api_last_probe_timestamp` short by up to seventeen minutes and
// quietly turn the freshness column into a measure of the flush.
func (b *passBuffer) flush() (cells, bounds int) {
	var d directSink
	for _, v := range b.verdicts {
		d.verdict(v.e, v.api, v.verdict, v.latencyMs, v.at)
	}
	for _, r := range b.bounds {
		d.rangeBound(r.e, r.shape, r.bound, r.blocks)
	}
	return len(b.verdicts), len(b.bounds)
}
