package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// The two index probes answer one question together and neither answers it
// alone: at the same width, with both responses empty, how much more does a
// topic lookup cost this provider than an address lookup. Everything these
// tests hold is a precondition of that question meaning anything.

// findProbe returns the probe with that api label, or fails.
func findProbe(t *testing.T, api string) coverageProbe {
	t.Helper()
	for _, p := range coverageProbes {
		if p.API == api {
			return p
		}
	}
	t.Fatalf("probe %q not in coverageProbes", api)
	return coverageProbe{}
}

// blockRange pulls fromBlock and toBlock out of a built eth_getLogs body.
func blockRange(t *testing.T, body string) (uint64, uint64) {
	t.Helper()
	var req struct {
		Params []struct {
			FromBlock string `json:"fromBlock"`
			ToBlock   string `json:"toBlock"`
		} `json:"params"`
	}
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("probe body is not JSON: %v", err)
	}
	if len(req.Params) != 1 {
		t.Fatalf("expected one filter object, got %d", len(req.Params))
	}
	from, err := strconv.ParseUint(strings.TrimPrefix(req.Params[0].FromBlock, "0x"), 16, 64)
	if err != nil {
		t.Fatalf("fromBlock %q: %v", req.Params[0].FromBlock, err)
	}
	to, err := strconv.ParseUint(strings.TrimPrefix(req.Params[0].ToBlock, "0x"), 16, 64)
	if err != nil {
		t.Fatalf("toBlock %q: %v", req.Params[0].ToBlock, err)
	}
	return from, to
}

// THE OFF BY ONE THIS EXISTS FOR.
//
// fromBlock and toBlock are inclusive, so head-500 to head is 501 blocks, not
// 500. Dwellir's guard admits exactly 500 and answers "eth_getLogs range of
// 501 blocks exceeds the 500-block limit", measured against the live endpoint
// on 2026-11-13. One block too many would have left Dwellir's cell empty
// forever, and an empty cell reads as the provider refusing rather than as us
// asking wrong.
func TestIndexProbesAskExactlyFiveHundredBlocks(t *testing.T) {
	const head = 21_000_000
	for _, api := range []string{"eth_getlogs_index_address", "eth_getlogs_index_topic"} {
		p := findProbe(t, api)
		body, ok := p.body(head)
		if !ok {
			t.Fatalf("%s: probe declined to build at head %d", api, head)
		}
		from, to := blockRange(t, body)
		if got := to - from + 1; got != 500 {
			t.Errorf("%s asks for %d blocks, want 500 inclusive (from %d to %d)",
				api, got, from, to)
		}
	}
}

// The pair only isolates the index if both come back empty. An address that
// holds logs or a topic that matches a real signature would put bytes on the
// wire and the difference would stop being about the index.
func TestIndexProbesCannotMatchAnything(t *testing.T) {
	addr := findProbe(t, "eth_getlogs_index_address")
	body, _ := addr.body(21_000_000)
	if !strings.Contains(body, addressEmpty) {
		t.Errorf("address index probe does not use the empty address")
	}
	if strings.Contains(body, "topics") {
		t.Errorf("address index probe carries a topic filter, so it is not an address-only lookup")
	}

	topic := findProbe(t, "eth_getlogs_index_topic")
	body, _ = topic.body(21_000_000)
	if !strings.Contains(body, topicImpossible) {
		t.Errorf("topic index probe does not use the impossible topic")
	}
	if strings.Contains(body, `"address"`) {
		t.Errorf("topic index probe carries an address filter, so it is not a topic-only lookup")
	}
	// A keccak256 signature is 32 bytes. An all-0xee value is not a preimage
	// anybody holds, which is the whole point.
	if len(strings.TrimPrefix(topicImpossible, "0x")) != 64 {
		t.Errorf("impossible topic is %d hex chars, a topic is 64",
			len(strings.TrimPrefix(topicImpossible, "0x")))
	}
}

// An empty log array is the expected answer here, so the verdict rule has to
// read it as served. resultOrError would call it a refusal and both cells
// would publish zero, which is the opposite of the truth.
func TestIndexProbesTreatEmptyAsServed(t *testing.T) {
	for _, api := range []string{"eth_getlogs_index_address", "eth_getlogs_index_topic"} {
		p := findProbe(t, api)
		got, err := p.supported([]byte(`{"jsonrpc":"2.0","id":1,"result":[]}`))
		if err != nil {
			t.Fatalf("%s: empty array errored: %v", api, err)
		}
		if got != verdictServed {
			t.Errorf("%s reads an empty array as %q, want %q", api, got, verdictServed)
		}
	}
}

// A chain younger than the window cannot answer, and asking anyway would
// publish a refusal that belongs to the chain's age and not to the provider.
func TestIndexProbesDeclineOnAYoungChain(t *testing.T) {
	for _, api := range []string{"eth_getlogs_index_address", "eth_getlogs_index_topic"} {
		p := findProbe(t, api)
		if _, ok := p.body(coverageIndexSpan); ok {
			t.Errorf("%s built a request at head %d, which would ask for block 0 and below",
				api, coverageIndexSpan)
		}
		if _, ok := p.body(coverageIndexSpan + 1); !ok {
			t.Errorf("%s declined at head %d, where exactly 500 blocks exist",
				api, coverageIndexSpan+1)
		}
	}
}
