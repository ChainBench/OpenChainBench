package main

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"
)

func TestPollArrivalMidpoint(t *testing.T) {
	var p pollArrival
	t0 := time.Unix(1000, 0)
	if _, ok := p.observe(t0, true, time.Second); ok {
		t.Fatal("first answer has no previous receive time, must not time")
	}
	seen, ok := p.observe(t0.Add(300*time.Millisecond), true, time.Second)
	if !ok || !seen.Equal(t0.Add(150*time.Millisecond)) {
		t.Fatalf("want midpoint +150ms, got %v ok=%v", seen.Sub(t0), ok)
	}
	if _, ok := p.observe(t0.Add(600*time.Millisecond), false, time.Second); ok {
		t.Fatal("no new head, nothing to time")
	}
	if _, ok := p.observe(t0.Add(2*time.Second), true, time.Second); ok {
		t.Fatal("gap wider than maxGap must be dropped")
	}
	p.miss()
	if _, ok := p.observe(t0.Add(2100*time.Millisecond), true, time.Second); ok {
		t.Fatal("after a miss the next head must not be timed")
	}
}

func nh(height int64, hash, prev, final string, tsMs int64) nearHeader {
	return nearHeader{Height: height, Hash: hash, PrevHash: prev, LastFinalBlock: final, ts: (1_700_000_000_000 + tsMs) * 1e6}
}

func TestNearStateFinality(t *testing.T) {
	st := newNearState()
	// 100 at t=0, 101 at 600 ms, 102 at 1200 ms naming 100 final.
	if _, ok := st.observe(nh(100, "h100", "h99", "h98", 0)); ok {
		t.Fatal("parent and final unseen, nothing to time")
	}
	st.observe(nh(101, "h101", "h100", "h99", 600))
	ms, ok := st.observe(nh(102, "h102", "h101", "h100", 1250))
	if !ok || ms != 1250 {
		t.Fatalf("want 1250 ms for block 100, got %v %v", ms, ok)
	}
	// Repeat poll of the same head: no double count.
	if _, ok := st.observe(nh(102, "h102", "h101", "h100", 1250)); ok {
		t.Fatal("same head twice must not re-time")
	}
	// Finality stalls: 103 still names 100. Not a first naming.
	if _, ok := st.observe(nh(103, "h103", "h102", "h100", 1800)); ok {
		t.Fatal("a head whose parent named the same final block is not the first")
	}
	// 105 seen without its parent 104: cannot tell it is first, skipped.
	if _, ok := st.observe(nh(105, "h105", "h104", "h103", 3000)); ok {
		t.Fatal("unseen parent must skip")
	}
	// 106 (parent 105 named 103) names 104, which we never saw: skipped.
	if _, ok := st.observe(nh(106, "h106", "h105", "h104", 3600)); ok {
		t.Fatal("unseen final block must skip")
	}
	// remember() fills a fetched parent / final block without emitting.
	st2 := newNearState()
	st2.remember(nh(200, "h200", "h199", "h198", 10000))
	st2.remember(nh(201, "h201", "h200", "h199", 10600))
	if ms, ok := st2.observe(nh(202, "h202", "h201", "h200", 11230)); !ok || ms != 1230 {
		t.Fatalf("fetched parent and final: want 1230, got %v %v", ms, ok)
	}
	// 107 names 105 (seen at 3000), parent 106 named 104: timed.
	ms, ok = st.observe(nh(107, "h107", "h106", "h105", 4210))
	if !ok || ms != 1210 {
		t.Fatalf("want 1210, got %v %v", ms, ok)
	}
}

func TestParseNearBlock(t *testing.T) {
	h, err := parseNearBlock([]byte(`{"jsonrpc":"2.0","result":{"author":"x","header":{"height":222883811,"hash":"AAA","prev_hash":"ZZZ","last_final_block":"BBB","timestamp_nanosec":"1793716838472972412"}},"id":1}`))
	if err != nil || h.Height != 222883811 || h.Hash != "AAA" || h.PrevHash != "ZZZ" || h.LastFinalBlock != "BBB" || h.ts != 1793716838472972412 {
		t.Fatalf("got %+v %v", h, err)
	}
	if _, err := parseNearBlock([]byte(`{"jsonrpc":"2.0","error":{"message":"too many requests"},"id":1}`)); err == nil {
		t.Fatal("rpc error must surface")
	}
	if _, err := parseNearBlock([]byte(`{"jsonrpc":"2.0","result":{"header":{"height":1,"hash":"A"}},"id":1}`)); err == nil {
		t.Fatal("incomplete header must error")
	}
}

func TestAlgorandAdvance(t *testing.T) {
	st := &algorandState{}
	t0 := time.Unix(3000, 0)
	if _, ok := st.advance(100, t0); ok {
		t.Fatal("first round only anchors")
	}
	ms, ok := st.advance(101, t0.Add(2810*time.Millisecond))
	if !ok || ms != 2810 {
		t.Fatalf("want 2810, got %v %v", ms, ok)
	}
	if _, ok := st.advance(103, t0.Add(8*time.Second)); ok {
		t.Fatal("skipped round must not be timed")
	}
	if _, ok := st.advance(103, t0.Add(9*time.Second)); ok {
		t.Fatal("same round must not be timed")
	}
	if ms, ok := st.advance(104, t0.Add(11*time.Second)); !ok || ms != 3000 {
		t.Fatalf("after a gap, the next consecutive round is timed: %v %v", ms, ok)
	}
	if n, err := parseAlgorandStatus([]byte(`{"last-round":66604711,"time-since-last-round":2802045049}`)); err != nil || n != 66604711 {
		t.Fatalf("parse status: %d %v", n, err)
	}
}

func TestParseCometHeader(t *testing.T) {
	msg := []byte(`{"jsonrpc":"2.0","id":1,"result":{"query":"tm.event='NewBlockHeader'","data":{"type":"tendermint/event/NewBlockHeader","value":{"header":{"chain_id":"pacific-1","height":"241293224","time":"2026-11-03T14:45:30.14699844Z"}}}}}`)
	h, ts, ok := parseCometHeader(msg)
	want := time.Date(2026, 11, 3, 14, 45, 30, 146998440, time.UTC)
	if !ok || h != 241293224 || !ts.Equal(want) {
		t.Fatalf("got %d %v %v", h, ts, ok)
	}
	// The subscribe acknowledgement has an empty result.
	if _, _, ok := parseCometHeader([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`)); ok {
		t.Fatal("ack must not parse as a header")
	}
}

func TestKaiaOnTime(t *testing.T) {
	var st kaiaState
	if _, ok := st.onTime(100, 5000); ok {
		t.Fatal("first head only anchors")
	}
	start, ok := st.onTime(101, 5001)
	if !ok || start.Unix() != 5001 {
		t.Fatalf("on-time block: %v %v", start, ok)
	}
	// Late block: timestamp jumps 2 s, its fraction is in timestampFoS.
	if _, ok := st.onTime(102, 5003); ok {
		t.Fatal("late block must not be timed")
	}
	if _, ok := st.onTime(104, 5004); ok {
		t.Fatal("missed head must not be timed")
	}
	if _, ok := st.onTime(105, 5005); !ok {
		t.Fatal("next on-time block is timed again")
	}
	n, ts, ok := parseEVMHead([]byte(`{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"0x1","result":{"number":"0xdcc9f28","timestamp":"0x6ae9f323"}}}`))
	if !ok || n != 0xdcc9f28 || ts != 0x6ae9f323 {
		t.Fatalf("parse head: %d %d %v", n, ts, ok)
	}
}

// icpTimeAnswer builds a read_state answer whose certificate tree is
// fork(labeled("canister", pruned), labeled("time", leaf(leb128(ns)))).
func icpTimeAnswer(ns uint64) []byte {
	leb := make([]byte, binary.MaxVarintLen64)
	leb = leb[:binary.PutUvarint(leb, ns)]
	var tree bytes.Buffer
	cborHead(&tree, 4, 3)
	cborHead(&tree, 0, 1)
	// labeled "canister" -> pruned
	cborHead(&tree, 4, 3)
	cborHead(&tree, 0, 2)
	cborHead(&tree, 2, 8)
	tree.WriteString("canister")
	cborHead(&tree, 4, 2)
	cborHead(&tree, 0, 4)
	cborHead(&tree, 2, 32)
	tree.Write(make([]byte, 32))
	// labeled "time" -> leaf
	cborHead(&tree, 4, 3)
	cborHead(&tree, 0, 2)
	cborHead(&tree, 2, 4)
	tree.WriteString("time")
	cborHead(&tree, 4, 2)
	cborHead(&tree, 0, 3)
	cborHead(&tree, 2, uint64(len(leb)))
	tree.Write(leb)

	var cert bytes.Buffer
	cert.Write([]byte{0xd9, 0xd9, 0xf7})
	cborHead(&cert, 5, 2)
	cborText(&cert, "tree")
	cert.Write(tree.Bytes())
	cborText(&cert, "signature")
	cborHead(&cert, 2, 48)
	cert.Write(make([]byte, 48))

	var out bytes.Buffer
	out.Write([]byte{0xd9, 0xd9, 0xf7})
	cborHead(&out, 5, 1)
	cborText(&out, "certificate")
	cborHead(&out, 2, uint64(cert.Len()))
	out.Write(cert.Bytes())
	return out.Bytes()
}

func TestParseICPReadStateTime(t *testing.T) {
	const ns = uint64(1793717155123456789)
	got, err := parseICPReadStateTime(icpTimeAnswer(ns))
	if err != nil || got != int64(ns) {
		t.Fatalf("got %d %v", got, err)
	}
	if _, err := parseICPReadStateTime([]byte{0xa0}); err == nil {
		t.Fatal("empty map must error")
	}
	if _, err := parseICPReadStateTime([]byte{0x5a, 0xff}); err == nil {
		t.Fatal("truncated cbor must error")
	}
}

func TestICPRequestRoundTrips(t *testing.T) {
	v, err := cborDecode(icpReadStateTimeRequest(time.Unix(1793717155, 0)))
	if err != nil {
		t.Fatal(err)
	}
	content := v.(map[string]any)["content"].(map[string]any)
	if content["request_type"] != "read_state" {
		t.Fatalf("request_type: %v", content["request_type"])
	}
	if s := content["sender"].([]byte); len(s) != 1 || s[0] != 0x04 {
		t.Fatalf("sender must be the anonymous principal, got %x", s)
	}
	path := content["paths"].([]any)[0].([]any)[0].([]byte)
	if string(path) != "time" {
		t.Fatalf("path: %q", path)
	}
	if content["ingress_expiry"].(uint64) != uint64(1793717155)*1e9 {
		t.Fatalf("expiry: %v", content["ingress_expiry"])
	}
}

func TestStellarClosesWindow(t *testing.T) {
	st := newStellarCloses()
	t0 := time.Unix(1793717000, 0)
	// Ledgers 100..109 close every 5 s: no sample until 10 are known.
	for i := int64(0); i < 10; i++ {
		if _, ok := st.add(100+i, t0.Add(time.Duration(i)*5*time.Second)); ok {
			t.Fatalf("ledger %d: window not full yet", 100+i)
		}
	}
	// 110 closes 6 s after 109: mean over 100..110 = 51 s / 10.
	ms, ok := st.add(110, t0.Add(51*time.Second))
	if !ok || ms != 5100 {
		t.Fatalf("want 5100, got %v %v", ms, ok)
	}
	// The same ledger again (a replay) must not emit twice.
	if _, ok := st.add(110, t0.Add(51*time.Second)); ok {
		t.Fatal("replayed ledger emitted twice")
	}
	// A gap (111 missed) leaves 112 without its N-10 only if 102 is gone; it is not.
	if ms, ok := st.add(112, t0.Add(61*time.Second)); !ok || ms != 5100 {
		t.Fatalf("112 vs 102: want 5100, got %v %v", ms, ok)
	}
}
