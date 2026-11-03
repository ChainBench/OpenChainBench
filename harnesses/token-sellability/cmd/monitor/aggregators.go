package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
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
	WillQuote(ctx context.Context, token, amountWei string) (bool, error)
}

const (
	chainID   = 4663
	chainSlug = "robinhood"
	// The buyer in every question. One address for all of them, so no
	// aggregator is answering a different caller.
	taker = "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416"
)

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

func httpGet(ctx context.Context, c *http.Client, endpoint string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-client-id", "openchainbench")
	resp, err := c.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b, resp.StatusCode, nil
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

func (a sushiAgg) WillQuote(ctx context.Context, token, amt string) (bool, error) {
	v := url.Values{}
	v.Set("tokenIn", nativeSentinel)
	v.Set("tokenOut", token)
	v.Set("amount", amt)
	v.Set("maxSlippage", "0.05")
	v.Set("sender", taker)
	b, code, err := httpGet(ctx, a.c, "https://api.sushi.com/swap/v7/"+
		strconv.Itoa(chainID)+"?"+v.Encode())
	if err != nil {
		return false, err
	}
	if code != 200 {
		return false, badStatus(code, b)
	}
	var r struct {
		Status           string `json:"status"`
		AssumedAmountOut string `json:"assumedAmountOut"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return false, err
	}
	// Sushi answers 200 with a status field when it has no route, so the
	// status is read before the amount.
	return r.Status == "Success" && positive(r.AssumedAmountOut), nil
}

type kyberAgg struct{ c *http.Client }

func (a kyberAgg) Slug() string { return "kyberswap" }

func (a kyberAgg) WillQuote(ctx context.Context, token, amt string) (bool, error) {
	v := url.Values{}
	v.Set("tokenIn", nativeSentinel)
	v.Set("tokenOut", token)
	v.Set("amountIn", amt)
	v.Set("saveGas", "false")
	b, code, err := httpGet(ctx, a.c,
		"https://aggregator-api.kyberswap.com/"+chainSlug+"/api/v1/routes?"+v.Encode())
	if err != nil {
		return false, err
	}
	if code != 200 {
		return false, badStatus(code, b)
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
		return false, err
	}
	return r.Code == 0 && positive(r.Data.RouteSummary.AmountOut), nil
}

type paraswapAgg struct{ c *http.Client }

func (a paraswapAgg) Slug() string { return "paraswap" }

func (a paraswapAgg) WillQuote(ctx context.Context, token, amt string) (bool, error) {
	v := url.Values{}
	v.Set("srcToken", nativeSentinel)
	v.Set("destToken", token)
	v.Set("amount", amt)
	v.Set("network", strconv.Itoa(chainID))
	v.Set("srcDecimals", "18")
	// The destination decimals are unknown for an arbitrary token and
	// ParaSwap wants them. 18 is the common case; a wrong value changes the
	// SIZE it prices, not whether it will price at all, which is the only
	// thing asked here.
	v.Set("destDecimals", "18")
	v.Set("side", "SELL")
	b, code, err := httpGet(ctx, a.c, "https://api.paraswap.io/prices?"+v.Encode())
	if err != nil {
		return false, err
	}
	if code != 200 {
		return false, badStatus(code, b)
	}
	var r struct {
		PriceRoute struct {
			DestAmount string `json:"destAmount"`
		} `json:"priceRoute"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return false, err
	}
	return positive(r.PriceRoute.DestAmount), nil
}

type lifiAgg struct{ c *http.Client }

func (a lifiAgg) Slug() string { return "lifi" }

func (a lifiAgg) WillQuote(ctx context.Context, token, amt string) (bool, error) {
	v := url.Values{}
	v.Set("fromChain", strconv.Itoa(chainID))
	v.Set("toChain", strconv.Itoa(chainID))
	v.Set("fromToken", nativeSentinel)
	v.Set("toToken", token)
	v.Set("fromAmount", amt)
	v.Set("fromAddress", taker)
	b, code, err := httpGet(ctx, a.c, "https://li.quest/v1/quote?"+v.Encode())
	if err != nil {
		return false, err
	}
	// LI.FI answers 404 when it has no route, which is a no rather than a
	// failure to ask.
	if code == 404 {
		return false, nil
	}
	if code != 200 {
		return false, badStatus(code, b)
	}
	var r struct {
		Estimate struct {
			ToAmount string `json:"toAmount"`
		} `json:"estimate"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return false, err
	}
	return positive(r.Estimate.ToAmount), nil
}

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
	return []Aggregator{
		sushiAgg{c()}, kyberAgg{c()}, paraswapAgg{c()}, lifiAgg{c()},
	}
}

// chainSlugFor keeps the slug and the id from drifting apart in a file that
// hardcodes both.
func chainSlugFor(id int) string {
	if id == chainID {
		return chainSlug
	}
	return strings.ToLower(strconv.Itoa(id))
}
