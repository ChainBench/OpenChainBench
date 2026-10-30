package main

// coverage.go — bench 311 rpc-api-coverage: which APIs each keyed provider
// actually serves.
//
// Why this lives in the latency harness rather than its own service: the
// keyed endpoint URLs exist only in env (RPC_KEYED_URL_<PROVIDER>_<CHAIN>)
// because every one embeds an API key, and a second service would mean a
// second copy of those secrets. The no-key harness makes the same call for
// the same reason: rpc-capabilities deliberately emits three metric families
// from one binary because they share the client matrix.
//
// Why a separate metric family rather than a label on rpc_latency_*: adding
// a dimension to a metric nine specs already query turns a published column
// into two series and blanks it. metrics.go says so about the cold arm, and
// load.ts injects every active dimension into every provider query with no
// opt-out (metric_panels have ignore_dimensions; provider queries do not).
//
// What makes this cheap. Capability is a property of a plan and an
// architecture, not of a region or a minute, so it is probed once every six
// hours from ONE region. The tip probe runs 24 cells at 120 s, about 17,280
// calls a day per provider; this adds roughly 224. The quota guard still
// gates every call, because the whole point of that guard is that a dead
// free key blanks the bench until someone rotates it.
//
// The honesty rule this file is built around: a probe that could not reach a
// verdict must NOT write the gauge. Only a definitive answer does. A
// timeout, a paused quota or an unparseable body leave the previous value in
// place and increment a result counter instead, because publishing 0 for
// "we did not find out" is how a matrix tells a reader an API does not exist
// when it does.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// Capability does not change hour to hour. Six hours is four readings a
	// day, enough for the staleness witness to show the probe is alive
	// without spending on a question whose answer moves monthly.
	coverageInterval = 6 * time.Hour
	// Spacing between calls to one provider. meowrpc 429s on rapid
	// sequential calls in the no-key harness; the same courtesy here costs
	// nothing at this cadence.
	coveragePerCallSpacing = 2 * time.Second
	// A capability probe asks whether a filter shape is ACCEPTED, not how
	// much the endpoint can chew, so the span stays small and the response
	// stays bounded. The maximum accepted range is a different measurement
	// and gets its own gauge below.
	coverageLogSpan = 5
	// Depth for the archive question, matching the deepest bucket the
	// no-key harness probes so the two tiers are comparable.
	coverageArchiveDepth = 5_000_000
)

// Known-nonexistent transaction hash. Probing debug_traceTransaction and
// trace_transaction needs no real transaction: what distinguishes "this
// provider does not route the method" from "this provider routes it and the
// transaction is missing" is the SHAPE of the error. A method-not-found or a
// plan refusal names the method; a lookup failure names the transaction. So
// one call against a hash that cannot exist answers the capability question
// without a block lookup first, and costs one request.
const coverageAbsentTxHash = "0x" +
	"1111111111111111111111111111111111111111111111111111111111111111"

// ERC-20 Transfer(address,address,uint256). Present on every EVM chain we
// probe, so a topic-filtered query is a fair test everywhere.
const topicTransfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

// coverageProbe is one capability question.
type coverageProbe struct {
	API  string // the `api` label value, stable: specs select on it
	Kind string // "evm" | "solana"
	// body builds the JSON-RPC request. head is the current chain tip so a
	// probe can aim at real blocks; it is 0 when the tip is not yet known,
	// and a probe that needs it must say so by returning ok=false.
	body func(head uint64) (payload string, ok bool)
	// supported decides the verdict from a successful HTTP 200 body.
	// Returning ("", err) means no verdict was reached.
	supported func(raw []byte) (verdict string, err error)
}

// tierKeyed matches the label every other metric in this harness carries.
const tierKeyed = "keyed"

// verdicts
//
// Only the first three write the gauge. Everything else leaves the previous
// value alone, because a gauge is a claim about the PROVIDER and we may only
// make it when the provider actually answered.
const (
	verdictServed       = "served"      // gauge 1
	verdictUnsupported  = "unsupported" // gauge 0, the method is not routed
	verdictForbidden    = "forbidden"   // gauge 0, routed but withheld from our plan
	verdictAuthDeferred = "auth"        // undecidable alone, resolved per provider
	verdictUnknown      = "unknown"     // gauge untouched
)

// jsonRPCReply is the envelope every probe inspects.
type jsonRPCReply struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// classifyError turns a JSON-RPC error into a verdict.
//
// -32601 is the standard "method not found" and is unambiguous. Beyond that
// providers are inventive, and the distinction that matters to a reader is
// whether the method is absent or merely withheld, so the message is matched
// for both families. Anything that fits neither is explicitly unknown rather
// than quietly counted as unsupported: a rate-limit message is not evidence
// about capability.
func classifyError(code int, msg string) string {
	m := strings.ToLower(msg)
	if code == -32601 {
		return verdictUnsupported
	}
	for _, s := range []string{
		"method not found", "method not supported", "not supported",
		"unsupported method", "does not exist", "unknown method",
		"method does not exist", "not available on this network",
	} {
		if strings.Contains(m, s) {
			return verdictUnsupported
		}
	}
	for _, s := range []string{
		"not enabled", "upgrade your plan", "not included", "requires a paid",
		"add-on", "not authorized", "unauthorized", "forbidden",
		"insufficient permissions", "plan does not",
	} {
		if strings.Contains(m, s) {
			return verdictForbidden
		}
	}
	return verdictUnknown
}

// servedUnlessMethodMissing is the verdict rule for every probe whose
// parameters are deliberately unsatisfiable (the absent transaction hash).
// A parameter-level complaint proves the method is routed, which is exactly
// what is being asked.
func servedUnlessMethodMissing(raw []byte) (string, error) {
	var r jsonRPCReply
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", fmt.Errorf("unparseable body: %w", err)
	}
	if r.Error == nil {
		return verdictServed, nil
	}
	v := classifyError(r.Error.Code, r.Error.Message)
	if v == verdictUnknown {
		// The method answered and complained about something other than
		// itself, which is the signal we wanted.
		if looksLikeLookupFailure(r.Error.Message) {
			return verdictServed, nil
		}
		return "", fmt.Errorf("unclassified error %d: %s",
			r.Error.Code, truncate(r.Error.Message, 120))
	}
	return v, nil
}

// looksLikeLookupFailure recognises a complaint about the ARGUMENTS rather
// than about the method. It is the positive signal: a server that parsed the
// method, went looking, and failed on what it found has routed the method,
// which is the capability question.
//
// The size-refusal family at the bottom was added after running the probe
// against a real Helius free key on 2026-10-29. A bounded getProgramAccounts
// against the SPL Token program came back `-32600 Too many accounts requested
// (Large number of pubkeys)`. That is the server counting accounts and
// declining on response size, so the method is plainly routed; a provider
// that did not route it answers "method not found". Before this the message
// matched nothing, the probe reached no verdict, and the Solana cell would
// have stayed empty forever behind an unclassified log line.
//
// Worth knowing when reading the matrix: routed is not "will answer a big
// one". A size limit is a real and separate property, and the only honest
// place for it is its own measurement, the way eth_getLogs gets a max-range
// gauge rather than a boolean.
func looksLikeLookupFailure(msg string) bool {
	m := strings.ToLower(msg)
	for _, s := range []string{
		"not found", "transaction not found", "no trace", "missing",
		"could not be found", "does not have", "unknown block",
		"historical state", "required historical state",
		// argument-size refusals: the method ran and declined the request
		"too many accounts", "large number of pubkeys", "response too large",
		"result too large", "query exceeds", "too many results",
		"exceeds the maximum", "range too large",
		// state the node no longer holds. Measured from GetBlock on the first
		// live pass: `-32603 state at block #48253969 is pruned`. The method
		// ran and the state is gone, which archive_5m must read as not an
		// archive and a trace probe must read as routed. Both fall out of
		// this one family, see the comment above.
		"is pruned", "state is not available", "pruned state",
		// an index the node chose not to build. GetBlock on Solana:
		// `-32010 Tokenkeg... excluded from account secondary indexes; this
		// RPC method unavailable for key`. The error names the ACCOUNT, so
		// the method is routed; what is missing is the index for that
		// program. Exactly the case the methodology bullet covers: routed is
		// not "will answer whatever you send it".
		"secondary indexes", "excluded from account",
	} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// resultOrError is the verdict rule for probes whose parameters ARE
// satisfiable: a non-null result means served.
func resultOrError(raw []byte) (string, error) {
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
	if len(r.Result) == 0 || string(r.Result) == "null" {
		return "", fmt.Errorf("200 with null result and no error")
	}
	return verdictServed, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func hexNum(v uint64) string { return "0x" + strconv.FormatUint(v, 16) }

// coverageProbes is the probe set. Order is stable so the log reads the same
// every pass.
//
// Deliberately NOT here, and the spec must render it as "not probed" rather
// than as a zero: the Beacon API and archive blob sidecars. Those live on a
// different base URL from the JSON-RPC endpoint, and our env carries only
// the RPC URL. Emitting 0 for them would state that no provider serves the
// Beacon API, which is false. They need their own env variables first.
var coverageProbes = []coverageProbe{
	// The compute-bound call and the reference it is only meaningful
	// against, first in the list because they have to run adjacent in the
	// pass: their difference is the work only if they share the same
	// network conditions. See heavycall.go for the measurements that
	// settled the size and for why the absolute number answers a different
	// question than the review asked.
	ethCallProbe("eth_call_light", lightCallSubCalls),
	ethCallProbe("eth_call_heavy", heavyCallSubCalls),
	{
		API:  "eth_getlogs_nofilter",
		Kind: "evm",
		body: func(head uint64) (string, bool) {
			if head == 0 {
				return "", false
			}
			from := head - coverageLogSpan
			return fmt.Sprintf(
				`{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"%s","toBlock":"%s"}]}`,
				hexNum(from), hexNum(head)), true
		},
		// An empty log array is a legitimate served answer, so this probe
		// cannot use resultOrError's non-null rule.
		supported: func(raw []byte) (string, error) {
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
			if len(r.Result) == 0 {
				return "", fmt.Errorf("200 with no result field")
			}
			return verdictServed, nil
		},
	},
	{
		API:  "eth_getlogs_address",
		Kind: "evm",
		body: func(head uint64) (string, bool) {
			if head == 0 {
				return "", false
			}
			// The zero address is accepted by every implementation and
			// matches almost nothing, which keeps the response tiny. The
			// question is whether the filter shape is accepted, not what it
			// returns.
			return fmt.Sprintf(
				`{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"%s","toBlock":"%s","address":"0x0000000000000000000000000000000000000000"}]}`,
				hexNum(head-coverageLogSpan), hexNum(head)), true
		},
		supported: coverageProbes0EmptyOK,
	},
	{
		API:  "eth_getlogs_topics",
		Kind: "evm",
		body: func(head uint64) (string, bool) {
			if head == 0 {
				return "", false
			}
			return fmt.Sprintf(
				`{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"%s","toBlock":"%s","topics":["%s"]}]}`,
				hexNum(head-coverageLogSpan), hexNum(head), topicTransfer), true
		},
		supported: coverageProbes0EmptyOK,
	},
	{
		API:  "debug_tracetransaction",
		Kind: "evm",
		body: func(uint64) (string, bool) {
			return fmt.Sprintf(
				`{"jsonrpc":"2.0","id":1,"method":"debug_traceTransaction","params":["%s",{"tracer":"callTracer"}]}`,
				coverageAbsentTxHash), true
		},
		supported: servedUnlessMethodMissing,
	},
	{
		API:  "trace_block",
		Kind: "evm",
		body: func(head uint64) (string, bool) {
			if head == 0 {
				return "", false
			}
			return fmt.Sprintf(
				`{"jsonrpc":"2.0","id":1,"method":"trace_block","params":["%s"]}`,
				hexNum(head-1)), true
		},
		supported: servedUnlessMethodMissing,
	},
	{
		API:  "eth_getblockreceipts",
		Kind: "evm",
		body: func(uint64) (string, bool) {
			return `{"jsonrpc":"2.0","id":1,"method":"eth_getBlockReceipts","params":["latest"]}`, true
		},
		supported: resultOrError,
	},
	{
		API:  "archive_5m",
		Kind: "evm",
		body: func(head uint64) (string, bool) {
			if head <= coverageArchiveDepth {
				// A chain younger than the depth cannot answer the question,
				// and saying "unsupported" would be a lie about the provider.
				return "", false
			}
			// Vitalik: a stable, well-known, non-zero balance at any depth,
			// so a pruned node answers with an explicit error or a wrong
			// zero rather than something ambiguous. Same address and reason
			// as the no-key harness.
			return fmt.Sprintf(
				`{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","%s"]}`,
				hexNum(head-coverageArchiveDepth)), true
		},
		supported: func(raw []byte) (string, error) {
			var r jsonRPCReply
			if err := json.Unmarshal(raw, &r); err != nil {
				return "", fmt.Errorf("unparseable body: %w", err)
			}
			if r.Error != nil {
				v := classifyError(r.Error.Code, r.Error.Message)
				if v == verdictUnknown {
					if looksLikeLookupFailure(r.Error.Message) {
						// "missing trie node" is a pruned node answering
						// honestly: the method is routed, the state is gone.
						return verdictUnsupported, nil
					}
					return "", fmt.Errorf("unclassified error %d: %s",
						r.Error.Code, truncate(r.Error.Message, 120))
				}
				return v, nil
			}
			var hex string
			if err := json.Unmarshal(r.Result, &hex); err != nil {
				return "", fmt.Errorf("result not a string")
			}
			// A pruned node sometimes returns 0x0 instead of erroring, for an
			// address that demonstrably held ether at that height. Counted as
			// unsupported, as in the no-key harness.
			if hex == "0x0" || hex == "0x" {
				return verdictUnsupported, nil
			}
			return verdictServed, nil
		},
	},
	{
		API:  "sol_getprogramaccounts",
		Kind: "solana",
		body: func(uint64) (string, bool) {
			// SPL Token program with a dataSize filter and a dataSlice of
			// length 0.
			//
			// An earlier version of this comment said the response was
			// "bounded by construction". It is not, and the correction
			// matters because it was the reason nobody looked. dataSlice
			// trims each account's DATA and does nothing to the length of
			// the array, and every SPL token account is exactly 165 bytes,
			// so the filter selects about ten million of them. Measured on
			// 2026-10-30 with this same shape: the stake program returned
			// 1,384,150 accounts and 311 MB, the address lookup table
			// program 2,318,733 and 517 MB.
			//
			// This probe is therefore safe only because every provider
			// refuses it on size, which is luck. It is kept anyway, because
			// that refusal is the informative answer here (Helius free:
			// "Too many accounts requested (10000000 pubkeys)"), and the
			// read is now capped in doPost so a provider that answers
			// instead cannot hand us half a gigabyte. What it cannot give is
			// a latency, since nothing was computed, which is why the
			// bounded probe below exists.
			return `{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",{"encoding":"base64","dataSlice":{"offset":0,"length":0},"filters":[{"dataSize":165}],"withContext":true}]}`, true
		},
		// Not resultOrError: measured against a real Helius free key, a
		// bounded query on the token program is refused on response size
		// (`-32600 Too many accounts requested`). The method is routed, the
		// request is too big, and only the first of those is the capability
		// question. Same rule as the trace probes, for the same reason.
		supported: servedUnlessMethodMissing,
	},
	{
		// The same method against a program with a SMALL account
		// population, which is the contrast the review asked for: "results
		// vary a lot by account". The probe above is refused on size by
		// everyone, so it proves the method is routed and can never produce
		// a latency, because nothing is computed before the refusal. This
		// one completes.
		//
		// Memo program, measured 2026-10-30: 21 accounts, 4.7 KB, 120 ms on
		// a Helius free key. Bounded by the program's real population rather
		// than by a filter we hope is honoured, which is the mistake the
		// note above corrects. It also discriminates: the same call is
		// refused on a public endpoint ("Indexed requests require a
		// personal token"), so this column separates a keyed plan from a
		// no-key one on a method both claim to serve.
		API:  "sol_getprogramaccounts_small",
		Kind: "solana",
		body: func(uint64) (string, bool) {
			return `{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",{"encoding":"base64","dataSlice":{"offset":0,"length":0},"withContext":true}]}`, true
		},
		// A populated program that returns its accounts is served; a refusal
		// about the request rather than the method is still served, same rule
		// as the probe above.
		supported: servedUnlessMethodMissing,
	},
	{
		// "Solana: RPC v2 changes which methods matter" was the review's
		// point, and it is measurable rather than a matter of opinion:
		// getProgramAccountsV2 is the paginated form, which is the only
		// bounded way to ask the question the two probes above have to work
		// around.
		//
		// Measured 2026-10-30: served by a Helius free key (2.3 KB, 255 ms),
		// "Method not found" on publicnode. So this is a real capability
		// split between providers and belongs in the matrix, which is
		// exactly what the review asked for.
		API:  "sol_getprogramaccounts_v2",
		Kind: "solana",
		body: func(uint64) (string, bool) {
			return `{"jsonrpc":"2.0","id":1,"method":"getProgramAccountsV2","params":["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",{"encoding":"base64","dataSlice":{"offset":0,"length":0},"limit":10}]}`, true
		},
		supported: servedUnlessMethodMissing,
	},
}

// coverageProbes0EmptyOK accepts an empty array as a served answer. Declared
// separately because two probes share it and a func literal cannot reference
// the slice it is being built into.
func coverageProbes0EmptyOK(raw []byte) (string, error) {
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
	if len(r.Result) == 0 {
		return "", fmt.Errorf("200 with no result field")
	}
	return verdictServed, nil
}

// coverageEnabled gates the loop to one region.
//
// Capability is a property of the plan, not of where the caller sits, so
// running it in all three regions would triple the spend for three identical
// answers. Set RPC_KEYED_COVERAGE=1 on exactly one service.
func coverageEnabled() bool {
	v := strings.TrimSpace(os.Getenv("RPC_KEYED_COVERAGE"))
	return v == "1" || strings.EqualFold(v, "true")
}

// StartCoverageLoop probes every (provider, chain, api) once, then every
// coverageInterval.
func StartCoverageLoop(ctx context.Context) {
	if !coverageEnabled() {
		fmt.Println("[coverage] disabled in this region (set RPC_KEYED_COVERAGE=1 on one service)")
		return
	}
	eps := endpoints()
	fmt.Printf("[coverage] enabled: %d endpoints x %d probes every %s\n",
		len(eps), len(coverageProbes), coverageInterval)

	go func() {
		// Let the latency loop populate /metrics and the chain tips first; a
		// probe that needs the head cannot run before one is known.
		select {
		case <-ctx.Done():
			return
		case <-time.After(90 * time.Second):
		}
		for {
			runCoveragePass(ctx, eps)
			select {
			case <-ctx.Done():
				return
			case <-time.After(coverageInterval):
			}
		}
	}()
}

// runCoveragePass asks every question once, resolving the ambiguous answers
// per ENDPOINT rather than per call.
//
// A 401 or 403 cannot be judged alone: the status does not separate "this
// method is not on our plan", which is a fact about the provider and belongs
// in the matrix as a 0, from "our access to this endpoint is gone", which is
// a fact about us and belongs nowhere near it. The tell is the rest of that
// endpoint's probes. If anything there served, the credential works and the
// refusal is about the method. If nothing served, the endpoint is the
// problem and we publish nothing at all.
//
// The granularity is (provider, chain) and not provider, which is the whole
// point. The first version grouped by provider, and Alchemy is the case that
// breaks it: measured right now it is probed on 27 cells and healthy on 6,
// with http_err 3779 against ok 1082, which is 22.2 percent, which is 6/27 to
// the decimal. Our free-tier key has been capped since 24 October on
// everything except HyperEVM and Robinhood Chain. Grouped by provider,
// Alchemy "serves something", so a refusal on Ethereum would have resolved as
// a plan refusal and published a 0 claiming Alchemy declines eth_getLogs.
// Grouped by endpoint, the Ethereum cell has no successes, so it publishes
// nothing and reads as not probed, which is the truth.
//
// openchainbench-21 found this by counting rpc_health where I had counted
// rpc_latency_milliseconds, which probe.go deletes on a failed probe and
// which therefore only ever exists where the probe succeeds.
func runCoveragePass(ctx context.Context, eps []Endpoint) {
	start := time.Now()
	var served, unsupported, forbidden, unknown, unusable int

	for _, e := range eps {
		head := tips.get(e.Chain)
		run := func(pr coverageProbe) string {
			v := probeCoverage(ctx, e, pr, head)
			select {
			case <-ctx.Done():
			case <-time.After(coveragePerCallSpacing):
			}
			return v
		}
		tally := coverEndpoint(e, run, ctx.Err)
		served += tally.served
		unsupported += tally.unsupported
		forbidden += tally.forbidden
		unknown += tally.unknown
		unusable += tally.unusable

		// After the capability questions, not before: the five-block columns
		// establish whether a filter shape is routed at all, and the ladder
		// below only makes sense for a shape that is. See rangeladder.go.
		select {
		case <-ctx.Done():
		case <-time.After(coveragePerCallSpacing):
		}
		probeGetLogsRange(ctx, e, head)
	}

	fmt.Printf("[coverage] pass done in %s: served=%d unsupported=%d forbidden=%d "+
		"unknown=%d endpoint_unusable=%d\n",
		time.Since(start).Truncate(time.Second),
		served, unsupported, forbidden, unknown, unusable)
}

// coverTally counts one endpoint's outcomes.
type coverTally struct {
	served, unsupported, forbidden, unknown, unusable int
}

// coverEndpoint walks one endpoint's probes and resolves its deferred auth
// answers. The prober is injected so the resolution rule can be tested
// without a network: the rule is the part that was wrong, not the HTTP.
func coverEndpoint(e Endpoint, probe func(coverageProbe) string, canceled func() error) coverTally {
	var t coverTally
	anyServed := false
	var deferred []string

	for _, pr := range coverageProbes {
		if pr.Kind != e.Kind {
			continue
		}
		if canceled != nil && canceled() != nil {
			return t
		}
		switch probe(pr) {
		case verdictServed:
			t.served++
			anyServed = true
		case verdictUnsupported:
			t.unsupported++
		case verdictForbidden:
			t.forbidden++
		case verdictAuthDeferred:
			deferred = append(deferred, pr.API)
		default:
			t.unknown++
		}
	}

	for _, api := range deferred {
		if anyServed {
			// The credential works on this endpoint, so the refusal is about
			// this method: a fact about the provider, hence a 0. Through
			// recordVerdict like every other write, so this path cannot
			// grow a latency: the round trip it has is a 403's.
			recordVerdict(e, api, verdictForbidden, 0)
			labelProbe(e, api, "forbidden")
			t.forbidden++
		} else {
			// Nothing on this endpoint answered. Our access failed, not their
			// API surface. Nothing is written, so the cell stays blank and
			// reads as not probed.
			labelProbe(e, api, "endpoint_unusable")
			t.unusable++
		}
	}
	if len(deferred) > 0 && !anyServed {
		fmt.Printf("[coverage] %s/%s: every probe returned an auth status and none "+
			"served. Our access to this endpoint, not their API surface. "+
			"Publishing nothing.\n", e.Provider, e.Chain)
	}
	return t
}

func labelProbe(e Endpoint, api, result string) {
	rpcAPIProbeTotal.WithLabelValues(
		e.Provider, e.Chain, api, result, currentRegion, tierKeyed).Inc()
}

// probeCoverage runs one question and records it. It returns the verdict so
// the pass can report a summary and resolve deferred auth cases; the gauge is
// written only for a definitive one.
func probeCoverage(ctx context.Context, e Endpoint, pr coverageProbe, head uint64) string {
	label := func(result string) { labelProbe(e, pr.API, result) }

	payload, ok := pr.body(head)
	if !ok {
		// Not askable right now (no head yet, or the chain is younger than
		// the archive depth). Recorded so the witness counter shows why the
		// gauge did not move, never published as a zero.
		label("not_applicable")
		return verdictUnknown
	}
	if !quota.allow(e.Provider, currentRegion) {
		label("quota_paused")
		return verdictUnknown
	}

	// Cold path on purpose: warm=true makes doPost send an unmeasured priming
	// request first, which doubles the spend to buy a comparable latency
	// number. A capability answer does not care whether the socket was
	// reused, so one request is the whole cost.
	raw, latencyMs, classified, err := doPost(ctx, e.URL, []byte(payload), false)
	if err != nil {
		// 402 is never a statement about the provider: it means our own
		// credits ran out. It can only be our failure, so it never writes a
		// gauge and it is not deferred either.
		if classified == "http_err" && strings.Contains(err.Error(), "status 402") {
			label("credits_exhausted")
			return verdictUnknown
		}
		// 401 and 403 are ambiguous until the rest of the provider's pass is
		// known, so hand them up rather than deciding here.
		if classified == "http_err" && isAuthStatus(err.Error()) {
			return verdictAuthDeferred
		}
		label(classified)
		return verdictUnknown
	}

	verdict, verr := pr.supported(raw)
	if verr != nil {
		// No verdict reached. Print it: an unclassified provider error is
		// how the next api value or message family gets added, and silence
		// here would leave the matrix quietly incomplete.
		fmt.Printf("[coverage] %-16s %-12s %-24s no verdict: %v\n",
			e.Provider, e.Chain, pr.API, verr)
		label("unclassified")
		return verdictUnknown
	}

	switch verdict {
	case verdictServed:
		recordVerdict(e, pr.API, verdict, latencyMs)
		label("ok")
	case verdictUnsupported:
		recordVerdict(e, pr.API, verdict, latencyMs)
		label("unsupported")
	case verdictForbidden:
		recordVerdict(e, pr.API, verdict, latencyMs)
		label("forbidden")
	default:
		label("unclassified")
		return verdictUnknown
	}
	return verdict
}

// recordVerdict publishes what one definitive probe established: the
// capability always, the latency only when the method was served.
//
// Both writes live here rather than at each call site so the pairing cannot
// drift. A refused method still has a round trip, and it is typically the
// fastest reading of the pass because "method not found" is cheap to
// produce; publishing it would rank a provider fast for declining to answer.
// Same rule as the gauge itself: a number here is a claim about the
// provider's handling of that method, and a refusal is not that.
//
// A verdict this does not recognise writes nothing at all, which is the
// behaviour the unknown cases depend on.
func recordVerdict(e Endpoint, api, verdict string, latencyMs float64) {
	switch verdict {
	case verdictServed:
		setCoverage(e, api, 1)
		rpcAPILatency.WithLabelValues(
			e.Provider, e.Chain, api, currentRegion, tierKeyed).Set(latencyMs)
	case verdictUnsupported, verdictForbidden:
		setCoverage(e, api, 0)
	}
}

// setCoverage publishes a verdict, and stamps when it was established.
//
// The timestamp is written here and nowhere else, so it is impossible to
// advance it without also publishing an answer. That is what makes
// `time() - rpc_api_last_probe_timestamp` the age of the VALUE rather than
// the age of the last attempt: when a provider starts failing, the gauge
// keeps its last reading and the stamp stops moving, so a frozen cell
// announces itself. A freshness column built on the probe counter would keep
// counting failures and report a stale tick as fresh.
func setCoverage(e Endpoint, api string, v float64) {
	rpcAPISupported.WithLabelValues(
		e.Provider, e.Chain, api, currentRegion, tierKeyed).Set(v)
	rpcAPILastProbe.WithLabelValues(
		e.Provider, e.Chain, api, currentRegion, tierKeyed).
		Set(float64(time.Now().Unix()))
}

func isAuthStatus(msg string) bool {
	return strings.Contains(msg, "status 401") ||
		strings.Contains(msg, "status 403") ||
		strings.Contains(msg, "status 402")
}
