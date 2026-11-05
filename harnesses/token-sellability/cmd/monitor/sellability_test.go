package main

import (
	"context"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// node serves canned eth_simulateV1 results. Each entry is the "calls" array
// of one simulated block, so a test can hand back a short list and prove the
// probe refuses it.
// revertData is what the canned node returns on every call. Tests that care
// about the reason set it; the rest leave it empty, which is also a case the
// decoder has to handle.
var revertData string

func node(t *testing.T, blocks ...[]string) *rpcClient {
	t.Helper()
	t.Cleanup(func() { revertData = "" })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out := make([]map[string]any, 0, len(blocks))
		for _, statuses := range blocks {
			calls := make([]map[string]any, 0, len(statuses))
			for _, s := range statuses {
				calls = append(calls, map[string]any{"status": s, "gasUsed": "0x1",
					"returnData": revertData})
			}
			out = append(out, map[string]any{"calls": calls})
		}
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": out})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return newRPC(srv.URL)
}

func quotes() (Quote, Quote) {
	return Quote{AmountOut: big.NewInt(1000), To: "0xrouter", Data: "0xdead", Value: "50000000000000000"},
		Quote{AmountOut: big.NewInt(900), To: "0xrouter", Data: "0xbeef", Value: "0"}
}

// The node answers a block-number override with a well-formed block and an
// EMPTY calls array, no error. Reading a status out of that list would
// publish a revert that never ran, against somebody's token.
func TestShortLegListIsInconclusiveNotUnsellable(t *testing.T) {
	buy, sell := quotes()
	p := Examine(context.Background(), node(t, []string{}), "0xme", "0xtok", buy, sell, 2)
	if p.SameBlock != Inconclusive {
		t.Errorf("an empty result must be inconclusive, got %q", p.SameBlock)
	}
	if p.Confirmed() {
		t.Error("a probe that produced nothing must never confirm")
	}
	if !strings.Contains(p.Reason, "ran 0 of 3") {
		t.Errorf("the reason must say what the node ran, got %q", p.Reason)
	}
}

// A buy that reverts says nothing about selling. Calling that unsellable
// blames the token for a route that never opened.
func TestBuyRevertIsNoRouteNotUnsellable(t *testing.T) {
	buy, sell := quotes()
	p := Examine(context.Background(), node(t, []string{"0x0", "0x1", "0x1"}),
		"0xme", "0xtok", buy, sell, 2)
	if p.SameBlock != NoRoute {
		t.Errorf("a failed buy is out of scope, got %q", p.SameBlock)
	}
}

func TestSellableAtBothTimings(t *testing.T) {
	buy, sell := quotes()
	c := node(t, []string{"0x1", "0x1", "0x1"})
	p := Examine(context.Background(), c, "0xme", "0xtok", buy, sell, 0)
	if p.SameBlock != Sellable {
		t.Errorf("same block: got %q", p.SameBlock)
	}
	if p.Confirmed() || p.Cooldown() {
		t.Error("a token that sells is neither confirmed nor a cooldown")
	}
}

// The one pattern that must never be published as a honeypot: blocked in the
// same block, fine a few blocks later. That is an anti-bot timer.
func TestCooldownIsNotAHoneypot(t *testing.T) {
	buy, sell := quotes()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Params []json.RawMessage `json:"params"`
		}
		body, _ := json.Marshal(map[string]any{})
		_ = json.NewDecoder(r.Body).Decode(&req)
		var first struct {
			BlockStateCalls []json.RawMessage `json:"blockStateCalls"`
		}
		if len(req.Params) > 0 {
			_ = json.Unmarshal(req.Params[0], &first)
		}
		// One block means the same-block attempt; more means the delayed one.
		if len(first.BlockStateCalls) == 1 {
			body, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": []map[string]any{
				{"calls": []map[string]any{{"status": "0x1"}, {"status": "0x1"}, {"status": "0x0"}}}}})
		} else {
			body, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": []map[string]any{
				{"calls": []map[string]any{{"status": "0x1"}, {"status": "0x1"}}},
				{"calls": []map[string]any{{"status": "0x1"}}}}})
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)

	p := Examine(context.Background(), newRPC(srv.URL), "0xme", "0xtok", buy, sell, 1)
	if !p.Cooldown() {
		t.Errorf("same=%q delayed=%q should read as a cooldown", p.SameBlock, p.Delayed)
	}
	if p.Confirmed() {
		t.Error("a cooldown must never be confirmed as unsellable")
	}
}

func TestMissingRouteIsOutOfScope(t *testing.T) {
	p := Examine(context.Background(), node(t), "0xme", "0xtok", Quote{}, Quote{}, 1)
	if p.SameBlock != NoRoute || p.Delayed != NoRoute {
		t.Errorf("no route must be out of scope, got %q/%q", p.SameBlock, p.Delayed)
	}
}

// Aggregators send decimal strings; the node rejects them with a message
// about hex prefixes that reads like its own fault.
func TestDecimalAmountsBecomeHex(t *testing.T) {
	if got := hexAmount("50000000000000000"); got != "0xb1a2bc2ec50000" {
		t.Errorf("decimal must convert, got %s", got)
	}
	if got := hexAmount("0xff"); got != "0xff" {
		t.Errorf("hex must pass through, got %s", got)
	}
	if got := hexAmount(""); got != "0x0" {
		t.Errorf("empty must be zero, got %s", got)
	}
}

func TestApproveTargetsTheSellRouter(t *testing.T) {
	d := approveData("0xAbC0000000000000000000000000000000000001")
	if !strings.HasPrefix(d, approveSel) {
		t.Error("must be an approve call")
	}
	if !strings.Contains(d, "abc0000000000000000000000000000000000001") {
		t.Error("the spender must be the sell router, lowercased and padded")
	}
	if !strings.HasSuffix(d, maxUint256) {
		t.Error("allowance must be unlimited so the sell cannot fail on it")
	}
}

// An unsellable verdict is a claim about somebody's token, so it has to carry
// the chain's own words for why. The probe used to discard them, and when the
// wrapped ether of the chain was recorded unsellable there was nothing left to
// read: 65 replays afterwards could not reproduce it.
func TestAnUnsellableVerdictCarriesTheChainsReason(t *testing.T) {
	// Error(string) with "TRANSFER_FAILED", as a router would return.
	revertData = "0x08c379a0" +
		"0000000000000000000000000000000000000000000000000000000000000020" +
		"000000000000000000000000000000000000000000000000000000000000000f" +
		"5452414e534645525f4641494c45440000000000000000000000000000000000"
	buy, sell := quotes()
	p := Examine(context.Background(), node(t, []string{"0x1", "0x1", "0x0"}),
		"0xme", "0xtok", buy, sell, 0)
	if p.SameBlock != Unsellable {
		t.Fatalf("expected unsellable, got %q", p.SameBlock)
	}
	if p.SameBlockWhy != "TRANSFER_FAILED" {
		t.Errorf("the reason must be decoded, got %q", p.SameBlockWhy)
	}
}

// A custom error has no string to decode, and naming it by selector is more
// use than calling it "reverted".
func TestACustomErrorIsNamedBySelector(t *testing.T) {
	revertData = "0xdeadbeef"
	buy, sell := quotes()
	p := Examine(context.Background(), node(t, []string{"0x1", "0x1", "0x0"}),
		"0xme", "0xtok", buy, sell, 0)
	if p.SameBlockWhy != "custom error 0xdeadbeef" {
		t.Errorf("got %q", p.SameBlockWhy)
	}
}

// A revert with no data at all must still say something, or a log line reads
// as a missing value rather than a silent contract.
func TestAnEmptyRevertStillSaysSomething(t *testing.T) {
	buy, sell := quotes()
	p := Examine(context.Background(), node(t, []string{"0x1", "0x1", "0x0"}),
		"0xme", "0xtok", buy, sell, 0)
	if p.SameBlockWhy != "reverted with no data" {
		t.Errorf("got %q", p.SameBlockWhy)
	}
}

// A token that sold leaves no reason behind, because there is nothing to
// explain and an empty field is how the board tells the two apart.
func TestASoldTokenCarriesNoReason(t *testing.T) {
	buy, sell := quotes()
	p := Examine(context.Background(), node(t, []string{"0x1", "0x1", "0x1"}),
		"0xme", "0xtok", buy, sell, 0)
	if p.SameBlockWhy != "" || p.DelayedWhy != "" {
		t.Errorf("a sale needs no reason, got %q / %q", p.SameBlockWhy, p.DelayedWhy)
	}
}
