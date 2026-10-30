package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The Solana probes, and the reason there are now three of them.
//
// The review asked for getProgramAccounts against several programs "since
// results vary a lot by account". Measuring that turned up why one program was
// never going to be enough, and a bug underneath it.
//
// Measured 2026-10-30, same request shape the shipped probe uses:
//
//	program                 accounts     reply    outcome
//	SPL Token (dataSize)    ~10,000,000  0.3 KB   refused on size
//	stake                    1,384,150   311 MB   accepted
//	address lookup table     2,318,733   517 MB   accepted
//	memo                            21   4.7 KB   accepted, 120 ms
//
// So "the response is bounded by construction", which the shipped comment
// claimed, was false: dataSlice length 0 trims each account's data and leaves
// one array entry per account. The SPL Token probe is safe only because every
// provider refuses it, and two sibling programs prove what the same shape does
// when a provider does not. doPost now caps the read for that reason.
func programIDOf(t *testing.T, payload string) string {
	t.Helper()
	var env struct {
		Method string            `json:"method"`
		Params []json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal([]byte(payload), &env); err != nil {
		t.Fatalf("probe payload is not JSON: %v", err)
	}
	if len(env.Params) == 0 {
		t.Fatalf("probe payload has no params")
	}
	var program string
	if err := json.Unmarshal(env.Params[0], &program); err != nil {
		t.Fatalf("first param is not a program id: %v", err)
	}
	return program
}

func solanaProbes(t *testing.T) map[string]coverageProbe {
	t.Helper()
	out := map[string]coverageProbe{}
	for _, pr := range coverageProbes {
		if pr.Kind == "solana" {
			out[pr.API] = pr
		}
	}
	return out
}

func TestSolanaProbesCoverDistinctPrograms(t *testing.T) {
	probes := solanaProbes(t)
	if len(probes) < 3 {
		t.Fatalf("want at least three Solana probes, found %d: one program cannot show that results vary by account", len(probes))
	}
	seen := map[string]string{}
	for api, pr := range probes {
		payload, ok := pr.body(0)
		if !ok {
			t.Fatalf("%s refused to build a payload; no Solana probe depends on the chain tip", api)
		}
		id := programIDOf(t, payload)
		if prev, dup := seen[id]; dup && !strings.Contains(api, "v2") && !strings.Contains(prev, "v2") {
			t.Fatalf("%s and %s ask the same program %s, so they cannot answer the question about account population", api, prev, id)
		}
		seen[id] = api
	}
}

func TestBoundedProbeAsksTheSmallProgram(t *testing.T) {
	// The bound has to come from the program's real population, not from a
	// filter the provider may count before applying: a memcmp on the USDC
	// mint was still refused by Helius with "Too many accounts requested
	// (10000000 pubkeys)", because the dataSize candidate set is counted
	// first. The memo program is 21 accounts whatever the filter does.
	p, ok := solanaProbes(t)["sol_getprogramaccounts_small"]
	if !ok {
		t.Fatal("the bounded Solana probe is missing")
	}
	payload, _ := p.body(0)
	if id := programIDOf(t, payload); !strings.HasPrefix(id, "MemoSq4gq") {
		t.Fatalf("bounded probe asks %s; it must ask a program whose population is small by nature", id)
	}
	if strings.Contains(payload, "dataSize") {
		t.Fatal("the bounded probe must not rely on a dataSize filter: that is the bound that was measured not to hold")
	}
}

func TestV2ProbeAsksTheV2Method(t *testing.T) {
	// getProgramAccountsV2 served by a Helius free key, "Method not found" on
	// publicnode: a real split between providers, which is what the matrix is
	// for.
	p, ok := solanaProbes(t)["sol_getprogramaccounts_v2"]
	if !ok {
		t.Fatal("the v2 Solana probe is missing")
	}
	payload, _ := p.body(0)
	if !strings.Contains(payload, `"method":"getProgramAccountsV2"`) {
		t.Fatalf("v2 probe does not call getProgramAccountsV2: %s", truncate(payload, 90))
	}
	if !strings.Contains(payload, `"limit":10`) {
		t.Fatal("the v2 probe must carry a limit: pagination is the whole reason this method matters here")
	}
}

func TestProbeResponseReadIsCapped(t *testing.T) {
	// A guard on the guard. One measured reply was 517 MB on a four-core box
	// with no swap, and the cap is what stands between that and an OOM. A
	// cap set absurdly high is the same as no cap, and one set too low would
	// truncate a legitimate reply into an unparseable body and blank a
	// column, so both ends are pinned.
	if maxProbeResponseBytes < 1<<20 {
		t.Fatalf("cap %d is below a megabyte and would truncate legitimate replies", maxProbeResponseBytes)
	}
	if maxProbeResponseBytes > 64<<20 {
		t.Fatalf("cap %d is high enough to let a 517 MB class reply through", maxProbeResponseBytes)
	}
}
