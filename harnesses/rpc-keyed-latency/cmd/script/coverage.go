package main

// coverage.go — bench 310 rpc-api-coverage: which APIs each keyed provider
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
	verdictServed       = "served"       // gauge 1
	verdictUnsupported  = "unsupported"  // gauge 0, the method is not routed
	verdictForbidden    = "forbidden"    // gauge 0, routed but withheld from our plan
	verdictAuthDeferred = "auth"         // undecidable alone, resolved per provider
	verdictUnknown      = "unknown"      // gauge untouched
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

func looksLikeLookupFailure(msg string) bool {
	m := strings.ToLower(msg)
	for _, s := range []string{
		"not found", "transaction not found", "no trace", "missing",
		"could not be found", "does not have", "unknown block",
		"historical state", "required historical state",
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
			// SPL Token program, with a dataSlice of length 0 and a dataSize
			// filter. The response is bounded by construction: we are asking
			// whether the method is routed, and an unbounded
			// getProgramAccounts against the token program would return
			// megabytes.
			return `{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",{"encoding":"base64","dataSlice":{"offset":0,"length":0},"filters":[{"dataSize":165}],"withContext":true}]}`, true
		},
		supported: resultOrError,
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

// deferredAuth is a probe that came back 401 or 403 and cannot be judged on
// its own.
//
// A status code alone does not separate "this method is not on our plan",
// which is a fact about the provider and belongs in the matrix as a 0, from
// "our key is dead", which is a fact about us and belongs nowhere near it.
// The tell is the rest of the pass: if some other probe to the same provider
// served, the key works and the refusal is about that method. If every probe
// to that provider failed the same way, the key is the problem and we publish
// nothing.
//
// This exists because openchainbench-21 pushed back on the first version,
// which wrote a 0 on any auth status. We have shipped that mistake before:
// RouteMesh's exhausted trial credits were published as a 78 percent error
// rate presented as their reliability.
type deferredAuth struct {
	endpoint Endpoint
	api      string
}

func runCoveragePass(ctx context.Context, eps []Endpoint) {
	start := time.Now()
	var served, unsupported, forbidden, unknown, keyDead int

	// Group by provider: the auth verdict is decided per provider, so a
	// provider's probes have to be resolved together.
	byProvider := map[string][]Endpoint{}
	order := []string{}
	for _, e := range eps {
		if _, seen := byProvider[e.Provider]; !seen {
			order = append(order, e.Provider)
		}
		byProvider[e.Provider] = append(byProvider[e.Provider], e)
	}

	for _, provider := range order {
		anyServed := false
		var deferred []deferredAuth

		for _, e := range byProvider[provider] {
			head := tips.get(e.Chain)
			for _, pr := range coverageProbes {
				if pr.Kind != e.Kind {
					continue
				}
				if ctx.Err() != nil {
					return
				}
				v := probeCoverage(ctx, e, pr, head)
				switch v {
				case verdictServed:
					served++
					anyServed = true
				case verdictUnsupported:
					unsupported++
				case verdictAuthDeferred:
					deferred = append(deferred, deferredAuth{endpoint: e, api: pr.API})
				default:
					unknown++
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(coveragePerCallSpacing):
				}
			}
		}

		// Resolve the deferred refusals now that the pass is in.
		for _, d := range deferred {
			if anyServed {
				setCoverage(d.endpoint, d.api, 0)
				labelProbe(d.endpoint, d.api, "forbidden")
				forbidden++
			} else {
				// Nothing from this provider answered. The key, not the
				// method, is what failed. No gauge is written, so the cell
				// stays blank and reads as "not probed" rather than claiming
				// the provider refuses an API it may well serve.
				labelProbe(d.endpoint, d.api, "key_unusable")
				keyDead++
			}
		}
		if len(deferred) > 0 && !anyServed {
			fmt.Printf("[coverage] %s: every probe returned an auth status and none served. "+
				"Treating the key as unusable, publishing nothing for it.\n", provider)
		}
	}

	fmt.Printf("[coverage] pass done in %s: served=%d unsupported=%d forbidden=%d "+
		"unknown=%d key_unusable=%d\n",
		time.Since(start).Truncate(time.Second),
		served, unsupported, forbidden, unknown, keyDead)
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
	raw, _, classified, err := doPost(ctx, e.URL, []byte(payload), false)
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
		setCoverage(e, pr.API, 1)
		label("ok")
	case verdictUnsupported:
		setCoverage(e, pr.API, 0)
		label("unsupported")
	case verdictForbidden:
		setCoverage(e, pr.API, 0)
		label("forbidden")
	default:
		label("unclassified")
		return verdictUnknown
	}
	return verdict
}

func setCoverage(e Endpoint, api string, v float64) {
	rpcAPISupported.WithLabelValues(
		e.Provider, e.Chain, api, currentRegion, tierKeyed).Set(v)
}

func isAuthStatus(msg string) bool {
	return strings.Contains(msg, "status 401") ||
		strings.Contains(msg, "status 403") ||
		strings.Contains(msg, "status 402")
}
