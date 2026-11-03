package main

import (
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
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
	for _, s := range []string{"status 500", "status 429", "status 200", "connection refused", "status 402"} {
		if isAuthStatus(s) {
			t.Errorf("%q wrongly detected as an auth status", s)
		}
	}
}

// The Alchemy case, which is why the deferral is scoped to an ENDPOINT and
// not to a provider.
//
// Measured 2026-10-29: Alchemy is probed on 27 cells and healthy on 6, with
// http_err 3779 against ok 1082, which is 22.2 percent, which is 6/27 to the
// decimal. Our free-tier key has been capped since 24 October everywhere
// except HyperEVM and Robinhood Chain. Grouped by PROVIDER, Alchemy serves
// something, so a 401 on Ethereum would resolve as a plan refusal and publish
// a 0 claiming Alchemy declines eth_getLogs. Grouped by ENDPOINT, the
// Ethereum cell has no successes of its own, so it publishes nothing.
func TestDeferredAuthIsScopedToTheEndpointNotTheProvider(t *testing.T) {
	evm := Endpoint{Provider: "testprov", Chain: "testchain", Kind: "evm", URL: "http://x"}

	// Endpoint where our access is gone: every probe returns an auth status.
	before := testutil.CollectAndCount(rpcAPISupported)
	tally := coverEndpoint(directSink{}, evm, func(coverageProbe) string {
		return verdictAuthDeferred
	}, nil)
	after := testutil.CollectAndCount(rpcAPISupported)
	if after != before {
		t.Fatalf("published %d series for an endpoint that never answered; "+
			"a capped key would be shown as the provider refusing", after-before)
	}
	if tally.unusable == 0 || tally.forbidden != 0 {
		t.Fatalf("tally = %+v, want every deferral counted unusable and none forbidden", tally)
	}

	// Endpoint where the credential works: one probe serves, so the refusals
	// are about those methods and do publish a 0.
	evm2 := Endpoint{Provider: "testprov", Chain: "workingchain", Kind: "evm", URL: "http://y"}
	first := true
	before = testutil.CollectAndCount(rpcAPISupported)
	tally = coverEndpoint(directSink{}, evm2, func(coverageProbe) string {
		if first {
			first = false
			return verdictServed
		}
		return verdictAuthDeferred
	}, nil)
	after = testutil.CollectAndCount(rpcAPISupported)
	if after <= before {
		t.Fatal("an endpoint whose credential works published nothing for its refusals")
	}
	if tally.forbidden == 0 {
		t.Fatalf("tally = %+v, want the refusals counted forbidden", tally)
	}
	if tally.unusable != 0 {
		t.Fatalf("tally = %+v, want nothing counted unusable when the endpoint served", tally)
	}
}

// The freshness stamp and the verdict must move together, always.
//
// `time() - rpc_api_last_probe_timestamp` is only the age of the published
// ANSWER while every stamp has a verdict beside it and vice versa. If a
// future edit stamps on a failed attempt, a frozen cell reads as fresh, which
// is the single thing the column exists to catch; if it writes a verdict
// without stamping, the column reads the cell as ancient forever. One series
// count each, compared after a mixed run, catches both directions.
//
// Expressed as an invariant rather than as a before-and-after, because an
// injected prober replaces probeCoverage, which is where the non-deferred
// verdicts are written. The first version of this test asserted through
// coverEndpoint and was measuring a seam the injection had removed.
func TestFreshnessStampAndVerdictAlwaysMoveTogether(t *testing.T) {
	seq := []struct {
		chain   string
		verdict string
	}{
		{"stamp-served", verdictAuthDeferred}, // resolves to unusable: no write
		{"stamp-unknown", verdictUnknown},     // no write
	}
	for _, s := range seq {
		coverEndpoint(directSink{}, Endpoint{
			Provider: "stampprov", Chain: s.chain, Kind: "evm", URL: "http://z",
		}, func(coverageProbe) string { return s.verdict }, nil)
	}
	// And one endpoint whose credential works, so its deferrals DO write.
	first := true
	coverEndpoint(directSink{}, Endpoint{
		Provider: "stampprov", Chain: "stamp-mixed", Kind: "evm", URL: "http://y",
	}, func(coverageProbe) string {
		if first {
			first = false
			return verdictServed
		}
		return verdictAuthDeferred
	}, nil)

	supported := testutil.CollectAndCount(rpcAPISupported)
	stamped := testutil.CollectAndCount(rpcAPILastProbe)
	if supported != stamped {
		t.Fatalf("%d verdicts published but %d stamped: a cell can now read "+
			"fresh while frozen, or ancient while current", supported, stamped)
	}
	if supported == 0 {
		t.Fatal("nothing was published, so the invariant proved nothing")
	}

	// setCoverage is the only writer, so it must do both.
	e := Endpoint{Provider: "stampprov", Chain: "stamp-direct", Kind: "evm"}
	setCoverage(e, "probe_api", 1, time.Now())
	if got := testutil.CollectAndCount(rpcAPISupported); got != supported+1 {
		t.Fatalf("setCoverage did not publish a verdict (%d -> %d)", supported, got)
	}
	if got := testutil.CollectAndCount(rpcAPILastProbe); got != stamped+1 {
		t.Fatalf("setCoverage published a verdict without stamping it (%d -> %d)", stamped, got)
	}
}

// A refusal on RESPONSE SIZE proves the method is routed, which is the
// capability question. The strings here were measured against real providers,
// not invented: the Helius one came back from a free key on 2026-10-29 when a
// bounded getProgramAccounts hit the SPL Token program.
//
// Getting this wrong is not a false accusation, it is a permanent blank: the
// probe reaches no verdict, logs "unclassified", and the cell never fills.
func TestSizeRefusalProvesTheMethodIsRouted(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{
			"helius getProgramAccounts, measured",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Too many accounts requested (Large number of pubkeys), Please use getProgramAccountsV2"}}`,
		},
		{
			"generic response size cap",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"response too large, reduce the range"}}`,
		},
		{
			"log range cap",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"query exceeds max block range 2000"}}`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := servedUnlessMethodMissing([]byte(c.body))
			if err != nil {
				t.Fatalf("reached no verdict, so the cell would stay blank forever: %v", err)
			}
			if got != verdictServed {
				t.Fatalf("got %q, want %q: a size refusal is the server declining the "+
					"request, not the method being absent", got, verdictServed)
			}
		})
	}
}

// And the inverse, so the widened family cannot swallow a real absence: a
// method-not-found must still read as unsupported even though it mentions the
// method by name.
func TestWidenedSizeFamilyDoesNotSwallowRealAbsence(t *testing.T) {
	got, err := servedUnlessMethodMissing([]byte(
		`{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"the method getProgramAccounts does not exist/is not available"}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != verdictUnsupported {
		t.Fatalf("got %q, want %q", got, verdictUnsupported)
	}
}

// The three families the first live pass could not classify, pinned exactly
// as the providers wrote them.
//
// Each one was a blank cell until it was added, and each is a different
// lesson. The pruned-state pair must read UNSUPPORTED through the archive
// probe and SERVED through a trace probe, from the same string, because the
// question differs: a node that lost the state is not an archive, but it
// plainly routed the method. The Solana one names the account rather than the
// method, so the method is routed and the missing thing is an index.
func TestFamiliesFromTheFirstLivePass(t *testing.T) {
	const pruned = `{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"state at block #48253969 is pruned"}}`
	const noIndex = `{"jsonrpc":"2.0","id":1,"error":{"code":-32010,"message":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA excluded from account secondary indexes; this RPC method unavailable for key"}}`

	// through a trace-style probe: the method ran, so it is served
	for name, body := range map[string]string{"pruned": pruned, "no index": noIndex} {
		got, err := servedUnlessMethodMissing([]byte(body))
		if err != nil {
			t.Fatalf("%s reached no verdict, so the cell stays blank: %v", name, err)
		}
		if got != verdictServed {
			t.Fatalf("%s read as %q through a trace probe, want %q", name, got, verdictServed)
		}
	}

	// through the archive probe: the same pruned string must mean NOT an archive
	var archive *coverageProbe
	for i := range coverageProbes {
		if coverageProbes[i].API == "archive_5m" {
			archive = &coverageProbes[i]
		}
	}
	if archive == nil {
		t.Fatal("no archive_5m probe")
	}
	got, err := archive.supported([]byte(pruned))
	if err != nil {
		t.Fatalf("the archive probe reached no verdict on a pruned node: %v", err)
	}
	if got != verdictUnsupported {
		t.Fatalf("a pruned node read as %q for archive support, want %q", got, verdictUnsupported)
	}
}
