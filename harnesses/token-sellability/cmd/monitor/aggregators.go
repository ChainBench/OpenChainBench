package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// The aggregators asked whether they will route INTO a token that cannot be
// sold back out.
//
// Being asked and answering are kept apart on purpose. An aggregator that
// does not serve this chain would otherwise score a perfect zero for never
// quoting anything, which is the opposite of what a zero should mean here.
// So every probe records that the question was put, and only then whether a
// route came back.
//
// Request shapes are taken from the adapters in harnesses/evm-swap-quoting,
// which have been answering on this chain for weeks, rather than written
// from documentation.
type Aggregator interface {
	Slug() string
	// WillQuote reports whether this aggregator returns a usable route INTO
	// the token for the given native amount. The error is the reason the
	// question could not be put at all, which is different from a no.
	//
	// decimals is the token's own, read from the chain. ParaSwap rejects a
	// wrong value outright with "Destination Decimals Mismatch" rather than
	// pricing a wrong size, which is what this file used to assume: the
	// comment here claimed a wrong guess changed the size and not the
	// answer, and 5 of 40 requests in one sweep proved otherwise.
	WillQuote(ctx context.Context, token string, decimals int, amountWei string) (Answer, error)
}

// Answer is what an aggregator said about one token, graded.
//
// "Declined" used to carry two opposite claims. Refusing because the token is
// screened out and refusing because there is no market are different
// statements about a router, and a reader deciding which one to trade through
// needs them apart: one says it protects you, the other says it has nothing
// to sell you here.
//
// Reserved is a route returned WITH a reservation the API itself states. Only
// Trnch publishes one today (guard.uncertain), so it stays out of the score
// and is published as its own column: a board that counted it would rank the
// talkativeness of an API rather than the quality of a route. KyberSwap
// carries nothing of the kind across 26 keys, and SushiSwap's priceImpact is
// a number rather than a verdict.
type Answer uint8

const (
	// Unanswered: the question could not be put at all. Never a verdict, and
	// never counted in the denominator, because the best score on this board
	// is earned by declining and never by failing to answer.
	Unanswered Answer = iota
	// Routed: a usable route, with nothing attached to it.
	Routed
	// Reserved: a usable route, and the aggregator says it is not sure.
	Reserved
	// Screened: refused, and the stated reason is the token.
	Screened
	// NoLiquidity: refused, and the stated reason is the market.
	NoLiquidity
)

// Routes reports whether this answer puts the caller into the token, which is
// what the headline counts. A reservation is still a route.
func (a Answer) Routes() bool { return a == Routed || a == Reserved }

func (a Answer) String() string {
	switch a {
	case Routed:
		return "routed"
	case Reserved:
		return "reserved"
	case Screened:
		return "screened"
	case NoLiquidity:
		return "no_liquidity"
	default:
		return "unanswered"
	}
}

const (
	chainID   = 4663
	chainSlug = "robinhood"
	// The buyer in every question. One address for all of them, so no
	// aggregator is answering a different caller.
	taker = "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416"
)

// A refusal is not a failure, and on this board the difference decides the
// ranking. Every aggregator here answers "I will not route you into this"
// with a 400 rather than an empty 200, and counting those as failures drops
// them from the denominator: only the tokens it DID route into survive, so
// an aggregator that declines half the traps scores the same as one that
// declines none. KyberSwap and ParaSwap both read exactly 100% until this
// was separated out.
//
// The matching is per aggregator and on the documented shape, never on the
// status alone. Treating any 400 as a refusal would be the same mistake
// mirrored: a malformed request of ours would then score as a decline, and
// declining is the best record on this board.
type refusal struct {
	// code is the aggregator's own numeric code, 0 when it uses none.
	code int
	// needle matches the message when a code is not enough.
	needle string
	// kind is which of the two refusals this is, and it is a judgement that
	// belongs in the open rather than inside a condition. Read it as: does
	// this sentence talk about the TOKEN or about the MARKET.
	kind Answer
}

// errorBody is the union of the three error shapes in use. Each aggregator
// fills one or two of these fields.
type errorBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Error   string `json:"error"`
}

// isRefusal reports whether a non-200 body is this aggregator saying no,
// rather than something that went wrong. The second return is the reason,
// for the log.
func isRefusal(body []byte, known []refusal) (Answer, bool) {
	var e errorBody
	if err := json.Unmarshal(body, &e); err != nil {
		return Unanswered, false
	}
	text := strings.ToLower(e.Message + " " + e.Error)
	for _, k := range known {
		if k.code != 0 && e.Code == k.code {
			return k.kind, true
		}
		if k.needle != "" && strings.Contains(text, strings.ToLower(k.needle)) {
			return k.kind, true
		}
	}
	return Unanswered, false
}

// rateLimited is returned when an aggregator says it will not serve us for a
// while. It is a different thing from a failed request and has to be, because
// the right response is to stop asking rather than to try the next token.
//
// Not honouring it is self-inflicted: LI.FI answered 40 of 40 with 429 on
// three consecutive sweeps because every blocked request counted against the
// window it was waiting out. The header says exactly how long to wait and the
// first version of this file read the limit while ignoring the reset.
type rateLimited struct {
	slug  string
	after time.Duration
	body  string
}

func (e *rateLimited) Error() string {
	return fmt.Sprintf("rate limited, retry in %s: %s", e.after.Round(time.Second), e.body)
}

// retryAfter reads how long to wait from whichever header the aggregator
// uses. Falls back to a minute, which is longer than any pace here and short
// enough to recover inside a sweep.
func retryAfter(h http.Header) time.Duration {
	for _, k := range []string{"Retry-After", "RateLimit-Reset", "X-RateLimit-Reset"} {
		if v := h.Get(k); v != "" {
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
				return time.Duration(n) * time.Second
			}
		}
	}
	return time.Minute
}

// badStatus renders a non-200 with the first of its body, because the body
// is where the reason is. A bare "http 400" cannot tell an unsupported chain
// from a token the aggregator cannot describe, and those two call for
// opposite fixes: one removes a row, the other corrects a request.
func badStatus(code int, body []byte) error {
	msg := strings.TrimSpace(string(body))
	msg = strings.Join(strings.Fields(msg), " ")
	if len(msg) > 180 {
		msg = msg[:180]
	}
	if msg == "" {
		return fmt.Errorf("http %d, empty body", code)
	}
	return fmt.Errorf("http %d: %s", code, msg)
}

func httpGet(ctx context.Context, c *http.Client, endpoint string) ([]byte, int, http.Header, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-client-id", "openchainbench")
	resp, err := c.Do(req)
	if err != nil {
		return nil, 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b, resp.StatusCode, resp.Header, nil
}

// positive reports whether a decimal amount string is a real route rather
// than a zero dressed as one. An empty or zero amount is a refusal, and
// reading it as a quote would credit an aggregator with routing into a token
// it declined.
func positive(s string) bool {
	if s == "" {
		return false
	}
	n, ok := new(big.Int).SetString(s, 10)
	return ok && n.Sign() > 0
}

type sushiAgg struct{ c *http.Client }

func (a sushiAgg) Slug() string { return "sushi" }

func (a sushiAgg) WillQuote(ctx context.Context, token string, decimals int, amt string) (Answer, error) {
	v := url.Values{}
	v.Set("tokenIn", nativeSentinel)
	v.Set("tokenOut", token)
	v.Set("amount", amt)
	v.Set("maxSlippage", "0.05")
	v.Set("sender", taker)
	b, code, hdr, err := httpGet(ctx, a.c, "https://api.sushi.com/swap/v7/"+
		strconv.Itoa(chainID)+"?"+v.Encode())
	if err != nil {
		return Unanswered, err
	}
	if code == 429 {
		return Unanswered, &rateLimited{a.Slug(), retryAfter(hdr), trimReason(string(b))}
	}
	if code != 200 {
		return Unanswered, badStatus(code, b)
	}
	var r struct {
		Status           string `json:"status"`
		AssumedAmountOut string `json:"assumedAmountOut"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return Unanswered, err
	}
	// Sushi answers 200 with a status field when it has no route, so the
	// status is read before the amount.
	return routeIf(r.Status == "Success" && positive(r.AssumedAmountOut)), nil
}

type kyberAgg struct{ c *http.Client }

func (a kyberAgg) Slug() string { return "kyberswap" }

func (a kyberAgg) WillQuote(ctx context.Context, token string, decimals int, amt string) (Answer, error) {
	v := url.Values{}
	v.Set("tokenIn", nativeSentinel)
	v.Set("tokenOut", token)
	v.Set("amountIn", amt)
	v.Set("saveGas", "false")
	b, code, hdr, err := httpGet(ctx, a.c,
		"https://aggregator-api.kyberswap.com/"+chainSlug+"/api/v1/routes?"+v.Encode())
	if err != nil {
		return Unanswered, err
	}
	if code == 429 {
		return Unanswered, &rateLimited{a.Slug(), retryAfter(hdr), trimReason(string(b))}
	}
	if code != 200 {
		if kind, no := isRefusal(b, kyberRefusals); no {
			return kind, nil
		}
		return Unanswered, badStatus(code, b)
	}
	var r struct {
		Code int `json:"code"`
		Data struct {
			RouteSummary struct {
				AmountOut string `json:"amountOut"`
			} `json:"routeSummary"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return Unanswered, err
	}
	return routeIf(r.Code == 0 && positive(r.Data.RouteSummary.AmountOut)), nil
}

type paraswapAgg struct{ c *http.Client }

func (a paraswapAgg) Slug() string { return "paraswap" }

func (a paraswapAgg) WillQuote(ctx context.Context, token string, decimals int, amt string) (Answer, error) {
	v := url.Values{}
	v.Set("srcToken", nativeSentinel)
	v.Set("destToken", token)
	v.Set("amount", amt)
	v.Set("network", strconv.Itoa(chainID))
	v.Set("srcDecimals", "18")
	// Their own, read from the chain. ParaSwap refuses a mismatch outright
	// rather than pricing a wrong size.
	v.Set("destDecimals", strconv.Itoa(decimals))
	v.Set("side", "SELL")
	b, code, hdr, err := httpGet(ctx, a.c, "https://api.paraswap.io/prices?"+v.Encode())
	if err != nil {
		return Unanswered, err
	}
	if code == 429 {
		return Unanswered, &rateLimited{a.Slug(), retryAfter(hdr), trimReason(string(b))}
	}
	if code != 200 {
		if kind, no := isRefusal(b, paraswapRefusals); no {
			return kind, nil
		}
		return Unanswered, badStatus(code, b)
	}
	var r struct {
		PriceRoute struct {
			DestAmount string `json:"destAmount"`
		} `json:"priceRoute"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return Unanswered, err
	}
	return routeIf(positive(r.PriceRoute.DestAmount)), nil
}

type lifiAgg struct{ c *http.Client }

func (a lifiAgg) Slug() string { return "lifi" }

func (a lifiAgg) WillQuote(ctx context.Context, token string, decimals int, amt string) (Answer, error) {
	v := url.Values{}
	v.Set("fromChain", strconv.Itoa(chainID))
	v.Set("toChain", strconv.Itoa(chainID))
	v.Set("fromToken", nativeSentinel)
	v.Set("toToken", token)
	v.Set("fromAmount", amt)
	v.Set("fromAddress", taker)
	b, code, hdr, err := httpGet(ctx, a.c, "https://li.quest/v1/quote?"+v.Encode())
	if err != nil {
		return Unanswered, err
	}
	// LI.FI answers 404 when it has no route, which is a no rather than a
	// failure to ask. It names the market, not the token: its judgements
	// about the token come back as 1011 and 1001 with a body.
	if code == 404 {
		return NoLiquidity, nil
	}
	if code == 429 {
		return Unanswered, &rateLimited{a.Slug(), retryAfter(hdr), trimReason(string(b))}
	}
	if code != 200 {
		if kind, no := isRefusal(b, lifiRefusals); no {
			return kind, nil
		}
		return Unanswered, badStatus(code, b)
	}
	var r struct {
		Estimate struct {
			ToAmount string `json:"toAmount"`
		} `json:"estimate"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return Unanswered, err
	}
	return routeIf(positive(r.Estimate.ToAmount)), nil
}

// The refusals each aggregator actually sends, read off its own responses
// on this chain rather than from documentation.
//
// LI.FI's 1011 is the strongest decline on the board: it names the token as
// invalid or deny-listed, which is precisely the behaviour this bench exists
// to reward. Scoring it as an outage was hiding the thing worth publishing.
var (
	kyberRefusals = []refusal{
		{code: 4008, needle: "route not found", kind: NoLiquidity},
	}
	paraswapRefusals = []refusal{
		// A judgement, stated here rather than buried: this one is a guard
		// on price impact, so it talks about what the trade would do and not
		// about whether a pool exists. The other two name the market.
		{needle: "ESTIMATED_LOSS_GREATER_THAN_MAX_IMPACT", kind: Screened},
		{needle: "No routes found", kind: NoLiquidity},
		{needle: "Token not found", kind: NoLiquidity},
	}
	trnchRefusals = []refusal{
		{needle: "not tradable", kind: Screened},
		{needle: "unsupported token", kind: Screened},
	}
	lifiRefusals = []refusal{
		{code: 1011, needle: "invalid or in deny list", kind: Screened},
		// 1001 is LI.FI simulating the route it was about to return and
		// finding the transfer reverts. On this cohort that is the whole
		// point: it looked, it saw the token would not move, and it refused
		// to hand over a transaction. Classified as a transport error, it
		// did not count as having been asked, so LI.FI earned nothing for
		// the one thing this board measures and its sample sat at 15 where
		// every other aggregator had 26.
		{code: 1001, needle: "could successfully generate a tx", kind: Screened},
		{needle: "no quote", kind: NoLiquidity},
		{needle: "not supported", kind: NoLiquidity},
	}
)

// trnchAgg is Trnch, and it is on THIS board and not the quote ones on
// purpose. They asked to be withdrawn from quote and latency on 2026-11-03
// and said in the same breath that the security bench interested them,
// because "avoir la meilleure quote sur quelque chose d'invendable par
// conception c'est pas top, nous on les refuse". That is a claim about
// behaviour, which is the kind this bench can settle.
//
// They refuse with 409 and {"error":"token not tradable through TRNCH"},
// which is a decline and not a fault: their own agent (TIA) screens the
// token before any router is polled. Measured 2026-11-04 on four tokens
// this harness had classified unsellable at both timings, plus the control,
// which came back 200 with four of five routers quoting.
//
// The key is still the withdrawal switch. Unset TRNCH_API_KEY and
// Aggregators never builds this, so no request is made and the row is
// absent rather than scored zero. Zero is the best score here and an
// aggregator that cannot be reached must not inherit it.
type trnchAgg struct {
	c   *http.Client
	key string
}

func (a trnchAgg) Slug() string { return "trnch" }

func (a trnchAgg) WillQuote(ctx context.Context, token string, decimals int, amt string) (Answer, error) {
	body, _ := json.Marshal(map[string]any{
		"tokenIn":     nativeSentinel,
		"tokenOut":    token,
		"amountIn":    amt,
		"decimalsIn":  18,
		"decimalsOut": decimals,
		"slippage":    0.01,
	})
	req, err := http.NewRequestWithContext(ctx, "POST", trnchQuoteURL, bytes.NewReader(body))
	if err != nil {
		return Unanswered, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.key)
	resp, err := a.c.Do(req)
	if err != nil {
		return Unanswered, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)

	// `notice` is deliberately absent from this struct and from every error
	// built here: it is a licence text repeated on every response, and
	// nothing downstream, logs included, should carry it.
	var r struct {
		Error string `json:"error"`
		Best  struct {
			AmountOut string `json:"amountOut"`
		} `json:"best"`
		// Their own reservation, read as they state it. `uncertain` is a
		// confidence about PRICING, its reason on this cohort being
		// "no-price", and it is published as that rather than promoted into
		// a verdict about a trap. Measured 2026-11-06: true on 3 of the 9
		// tokens whose sale reverted and on 0 of 12 the same sweeps sold,
		// so it is specific and not sensitive.
		Guard struct {
			Uncertain bool     `json:"uncertain"`
			Reasons   []string `json:"reasons"`
		} `json:"guard"`
	}
	_ = json.Unmarshal(b, &r)

	if resp.StatusCode == 429 {
		return Unanswered, &rateLimited{a.Slug(), retryAfter(resp.Header), trimReason(string(b))}
	}
	if resp.StatusCode != 200 {
		if kind, no := isRefusal(b, trnchRefusals); no {
			return kind, nil
		}
		// Their own error field only, never the whole body.
		if r.Error != "" {
			return Unanswered, fmt.Errorf("http %d: %s", resp.StatusCode, r.Error)
		}
		return Unanswered, fmt.Errorf("http %d", resp.StatusCode)
	}
	if !positive(r.Best.AmountOut) {
		return NoLiquidity, nil
	}
	if r.Guard.Uncertain {
		return Reserved, nil
	}
	return Routed, nil
}

// trnchQuoteURL is a variable so a test can serve canned bodies against it.
var trnchQuoteURL = "https://trnch.fun/api/bot/v1/quote"

// aggregatorsForTest lets a test substitute the cohort. Nil in production,
// where Aggregators builds the real one.
var aggregatorsForTest []Aggregator

// Aggregators returns the cohort, all keyless. Route is absent until its key
// is wired: an aggregator that cannot be asked must not appear at all,
// because an empty row on this board reads as "never routes into a trap".
func Aggregators() []Aggregator {
	if aggregatorsForTest != nil {
		return aggregatorsForTest
	}
	c := func() *http.Client { return &http.Client{Timeout: 30 * time.Second} }
	out := []Aggregator{
		sushiAgg{c()}, kyberAgg{c()}, paraswapAgg{c()}, lifiAgg{c()},
	}
	// The key IS the gate, and the one withdrawal switch this repo has. An
	// aggregator that cannot be asked is absent from the board rather than
	// scored zero, because zero is the top of this board.
	if k := strings.TrimSpace(os.Getenv("TRNCH_API_KEY")); k != "" {
		out = append(out, trnchAgg{c(), k})
	}
	return out
}

// chainSlugFor keeps the slug and the id from drifting apart in a file that
// hardcodes both.
func chainSlugFor(id int) string {
	if id == chainID {
		return chainSlug
	}
	return strings.ToLower(strconv.Itoa(id))
}

// routeIf grades the four aggregators that state nothing beyond a number.
//
// A positive amount is a route. An empty or zero one is NOT a refusal: these
// APIs answer 200 with no amount when they have nothing to offer, and
// calling that a refusal would credit them with a decision they did not
// make. It is the market, not the router.
func routeIf(ok bool) Answer {
	if ok {
		return Routed
	}
	return NoLiquidity
}
