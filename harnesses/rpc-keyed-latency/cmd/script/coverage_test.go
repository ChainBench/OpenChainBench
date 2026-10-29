package main

import (
	"strings"
	"testing"
)

// The rule every test here defends: a gauge value is a claim about the
// PROVIDER. 1 means they served it, 0 means they were asked and refused.
// Anything that is really a statement about US (our credits, our key, our
// rate limit, our timeout) must reach no verdict at all, so the series stays
// absent and the cell reads "not probed" instead of libelling the provider.
//
// This is not a hypothetical. RouteMesh's exhausted trial credits were once
// published as a 78 percent error rate presented as their reliability, and
// openchainbench-21 caught the first version of this file about to repeat it
// on any 401.

func TestClassifyErrorSeparatesTheirFaultFromOurs(t *testing.T) {
	cases := []struct {
		name string
		code int
		msg  string
		want string
	}{
		// Theirs: the method is not routed.
		{"standard method not found", -32601, "the method trace_block does not exist/is not available", verdictUnsupported},
		{"worded method not found", -32000, "Method not found", verdictUnsupported},
		{"unsupported method", -32000, "unsupported method: debug_traceTransaction", verdictUnsupported},
		{"not available on network", -32000, "debug_traceTransaction is not available on this network", verdictUnsupported},

		// Theirs: routed, but withheld from the plan we hold. Still a fact
		// about the provider, so still a 0.
		{"plan gated", -32000, "trace_block is not enabled for your plan", verdictForbidden},
		{"upgrade prompt", -32000, "Upgrade your plan to access archive data", verdictForbidden},
		{"add-on", -32000, "Debug & Trace API is an add-on", verdictForbidden},

		// Ours, or simply unknown. These must NOT become a 0.
		{"rate limited", -32005, "daily request count exceeded, request rate limited", verdictUnknown},
		{"over capacity", -32000, "server is overloaded, try again", verdictUnknown},
		{"empty message", -32000, "", verdictUnknown},
		{"billing", -32000, "monthly capacity limit reached", verdictUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := classifyError(c.code, c.msg); got != c.want {
				t.Fatalf("classifyError(%d, %q) = %q, want %q",
					c.code, c.msg, got, c.want)
			}
		})
	}
}

// A rate limit is the single most dangerous message to misread, because it is
// frequent and it looks like a refusal. Pinned separately so a future widening
// of the unsupported list cannot swallow it.
func TestRateLimitNeverReadsAsUnsupported(t *testing.T) {
	for _, msg := range []string{
		"429 Too Many Requests",
		"rate limit exceeded",
		"exceeded the quota for this method",
		"too many concurrent requests",
	} {
		if v := classifyError(-32005, msg); v == verdictUnsupported || v == verdictForbidden {
			t.Fatalf("%q classified %q: our own throttling would be published as the provider refusing", msg, v)
		}
	}
}

// The absent-transaction trick: one call answers the capability question
// without needing a real transaction, because a complaint ABOUT THE
// TRANSACTION proves the method is routed, while a complaint about the method
// proves it is not.
func TestServedUnlessMethodMissing(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		want    string
		wantErr bool
	}{
		{
			name: "routed, transaction simply absent",
			body: `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"transaction not found"}}`,
			want: verdictServed,
		},
		{
			name: "routed, needs historical state",
			body: `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"required historical state unavailable"}}`,
			want: verdictServed,
		},
		{
			name: "not routed",
			body: `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}`,
			want: verdictUnsupported,
		},
		{
			name: "withheld from the plan",
			body: `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"trace_block is not enabled for your plan"}}`,
			want: verdictForbidden,
		},
		{
			name: "a real trace came back",
			body: `{"jsonrpc":"2.0","id":1,"result":{"type":"CALL","from":"0x00","gas":"0x0"}}`,
			want: verdictServed,
		},
		{
			name:    "rate limited reaches no verdict",
			body:    `{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limit exceeded"}}`,
			wantErr: true,
		},
		{
			name:    "not JSON at all",
			body:    `<html>502 Bad Gateway</html>`,
			wantErr: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := servedUnlessMethodMissing([]byte(c.body))
			if c.wantErr {
				if err == nil {
					t.Fatalf("wanted no verdict, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

// An empty log array is a served answer. Getting this wrong would mark every
// provider as refusing a filter shape that works, because a 5 block span on a
// quiet chain legitimately matches nothing.
func TestEmptyLogArrayIsServed(t *testing.T) {
	got, err := coverageProbes0EmptyOK([]byte(`{"jsonrpc":"2.0","id":1,"result":[]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != verdictServed {
		t.Fatalf("empty result array read as %q, want %q", got, verdictServed)
	}
}

// A 200 with neither result nor error is not an answer. It used to be tempting
// to treat a missing result as "no data, so unsupported"; that is how a
// malformed gateway response becomes a published accusation.
func TestNoResultFieldReachesNoVerdict(t *testing.T) {
	if _, err := coverageProbes0EmptyOK([]byte(`{"jsonrpc":"2.0","id":1}`)); err == nil {
		t.Fatal("a 200 with no result and no error produced a verdict")
	}
	if _, err := resultOrError([]byte(`{"jsonrpc":"2.0","id":1,"result":null}`)); err == nil {
		t.Fatal("a null result produced a verdict")
	}
}

// The probe set has to be internally coherent, because a probe with a nil
// body or a duplicated api label fails at runtime in a way that looks like a
// provider problem.
func TestProbeSetIsCoherent(t *testing.T) {
	seen := map[string]bool{}
	for i, pr := range coverageProbes {
		if pr.API == "" {
			t.Fatalf("probe %d has no api label", i)
		}
		if seen[pr.API] {
			t.Fatalf("duplicate api label %q: two series would fight over one label set", pr.API)
		}
		seen[pr.API] = true
		if pr.API != strings.ToLower(pr.API) {
			t.Errorf("api %q is not lowercase; spec selectors are written lowercase", pr.API)
		}
		if pr.Kind != "evm" && pr.Kind != "solana" {
			t.Errorf("probe %q has kind %q, which no endpoint matches", pr.API, pr.Kind)
		}
		if pr.body == nil {
			t.Errorf("probe %q has no body builder", pr.API)
		}
		if pr.supported == nil {
			t.Errorf("probe %q has no verdict rule", pr.API)
		}
	}
	if len(seen) < 6 {
		t.Errorf("only %d probes; the bench needs enough columns to be worth a page", len(seen))
	}
}

// Probes that need the chain tip must refuse to run without one rather than
// aim at block zero, which an archive-less node answers happily and which
// would publish a 1 for archive support that was never tested.
func TestProbesNeedingHeadRefuseWithoutIt(t *testing.T) {
	needHead := map[string]bool{
		"eth_getlogs_nofilter": true,
		"eth_getlogs_address":  true,
		"eth_getlogs_topics":   true,
		"trace_block":          true,
		"archive_5m":           true,
	}
	for _, pr := range coverageProbes {
		_, ok := pr.body(0)
		if needHead[pr.API] && ok {
			t.Errorf("probe %q built a request with no known head", pr.API)
		}
		if !needHead[pr.API] && !ok {
			t.Errorf("probe %q refused to build without a head but does not need one", pr.API)
		}
	}
}

// The archive probe must not claim support on a chain too young to hold the
// depth it asks about. Robinhood Chain and Arc are both far younger than 5M
// blocks, and "unsupported" there would be a statement about the chain
// masquerading as one about the provider.
func TestArchiveProbeSkipsChainsYoungerThanItsDepth(t *testing.T) {
	var archive *coverageProbe
	for i := range coverageProbes {
		if coverageProbes[i].API == "archive_5m" {
			archive = &coverageProbes[i]
		}
	}
	if archive == nil {
		t.Fatal("no archive_5m probe")
	}
	if _, ok := archive.body(coverageArchiveDepth - 1); ok {
		t.Error("archive probe built a request on a chain younger than its depth")
	}
	if _, ok := archive.body(coverageArchiveDepth + 10); !ok {
		t.Error("archive probe refused a chain old enough to answer")
	}
}

// A pruned node that returns 0x0 for an address which demonstrably held ether
// at that height is refusing, not answering. Same treatment as the no-key
// harness.
func TestPrunedZeroBalanceIsUnsupported(t *testing.T) {
	var archive *coverageProbe
	for i := range coverageProbes {
		if coverageProbes[i].API == "archive_5m" {
			archive = &coverageProbes[i]
		}
	}
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":1,"result":"0x0"}`,
		`{"jsonrpc":"2.0","id":1,"result":"0x"}`,
	} {
		got, err := archive.supported([]byte(body))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != verdictUnsupported {
			t.Fatalf("%s read as %q, want %q", body, got, verdictUnsupported)
		}
	}
	got, err := archive.supported([]byte(`{"jsonrpc":"2.0","id":1,"result":"0x21e19e0c9bab2400000"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != verdictServed {
		t.Fatalf("a real historical balance read as %q, want %q", got, verdictServed)
	}
}

// The payloads must be valid JSON and must never carry a key. The URL holds
// the credential for every provider here; a body that somehow did too would
// put it in a log line the moment a probe printed its request.
func TestPayloadsCarryNoCredential(t *testing.T) {
	for _, pr := range coverageProbes {
		payload, ok := pr.body(6_000_000)
		if !ok {
			continue
		}
		low := strings.ToLower(payload)
		for _, forbidden := range []string{"api_key", "apikey", "authorization", "bearer", "token="} {
			if strings.Contains(low, forbidden) {
				t.Errorf("probe %q payload contains %q", pr.API, forbidden)
			}
		}
		if !strings.HasPrefix(payload, `{"jsonrpc":"2.0"`) {
			t.Errorf("probe %q payload does not start as a JSON-RPC request: %s",
				pr.API, payload[:min(40, len(payload))])
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// isAuthStatus decides whether a transport failure is deferred for a
// per-provider decision. 402 must be excluded: it is our credits, never their
// capability, and probeCoverage handles it before this is reached.
func TestAuthStatusDetection(t *testing.T) {
	for _, s := range []string{"status 401", "status 403"} {
		if !isAuthStatus(s) {
			t.Errorf("%q not detected as an auth status", s)
		}
	}
	for _, s := range []string{"status 500", "status 429", "status 200", "connection refused"} {
		if isAuthStatus(s) {
			t.Errorf("%q wrongly detected as an auth status", s)
		}
	}
}
