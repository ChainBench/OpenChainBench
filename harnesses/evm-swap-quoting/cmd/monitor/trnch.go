package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// TrnchProvider hits trnch.fun/api/bot/v1/quote. Robinhood Chain only: the
// request carries no chain id because the API serves that one chain.
//
// Added 2026-11-02 after Trnch asked to be measured. Two things about them
// are worth stating because they decide how the row reads.
//
// The amount they return is NET of their own 0.5 % integrator fee. That was
// not taken from their documentation, which does not say: four simultaneous
// comparisons against our own direct KyberSwap quote on the same pair gave
// -51.2, -49.3, -49.9 and -49.8 bps against a declared 0.500 %. Their
// `quotes` array repeats the same net figure, which is what made an earlier
// reading of the same response conclude the opposite.
//
// So the shortfall this row publishes legitimately contains their toll, the
// same way LI.FI's does, and the Routing only column is where their route is
// judged without it.
//
// The key is optional and is the withdrawal switch: unset TRNCH_API_KEY and
// the provider is never built, which matters because their API attaches a
// notice restricting reuse of what it returns. That notice is never stored,
// published or acted on as an instruction; it is a term for the operator to
// settle, and the env var is how the operator settles it in one move.
type TrnchProvider struct {
	region string
	apiKey string
	client *http.Client
}

// Base URL as a variable so the test can serve canned bodies against it.
var trnchBaseURL = "https://trnch.fun/api/bot/v1/quote"

func NewTrnchProvider(region, apiKey string) *TrnchProvider {
	return &TrnchProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *TrnchProvider) Slug() string { return "trnch" }

// Robinhood Chain alone. The quote request has no chain field, so asking it
// about any other chain would silently return a Robinhood price.
func (p *TrnchProvider) Supports(chainId int) bool { return chainId == 4663 }

func (p *TrnchProvider) Probe(ctx context.Context, pair TestPair) (Quote, error) {
	body, _ := json.Marshal(map[string]any{
		"tokenIn":     pair.TokenIn,
		"tokenOut":    pair.TokenOut,
		"amountIn":    pair.AmountWei,
		"decimalsIn":  pair.TokenInDec,
		"decimalsOut": pair.TokenOutDec,
		"slippage":    0.01,
	})

	req, _ := http.NewRequestWithContext(ctx, "POST", trnchBaseURL, bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	t0 := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, classifyNetErr(err))
		return failed(), err
	}
	defer resp.Body.Close()
	ms := time.Since(t0).Milliseconds()

	if resp.StatusCode == 429 {
		RecordThrottled(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("429")
	}
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "auth")
		return failed(), fmt.Errorf("auth status=%d", resp.StatusCode)
	}
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return failed(), fmt.Errorf("status=%d", resp.StatusCode)
	}

	// `notice` is deliberately absent from this struct: it is a licence text
	// repeated on every response and nothing downstream should carry it.
	var r struct {
		Best struct {
			Router    string  `json:"router"`
			AmountOut string  `json:"amountOut"`
			InUsd     float64 `json:"inUsd"`
		} `json:"best"`
		Routes []struct {
			Router string   `json:"router"`
			Status string   `json:"status"`
			FeeUsd *float64 `json:"feeUsd"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return failed(), err
	}
	if r.Best.AmountOut == "" || r.Best.AmountOut == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("no_route")
	}

	quote := okQuote(ms, r.Best.AmountOut)

	// The fee is reported per route in dollars, so it becomes basis points
	// against the input value they priced. Prefer the route they chose, then
	// fall back to any route that reports one.
	//
	// The fallback is not defensive padding. The first production probe
	// published an out amount, a tick and a 51.4 bps shortfall but no fee,
	// because matching on the chosen route's name found nothing that time.
	// Reading four live responses showed why the match was the wrong idea:
	// every successful route carries the SAME feeUsd (1.1216 across
	// kyberswap, sushi and lifi on one call), so the figure is a property of
	// the quote rather than of the route, and insisting on one name made a
	// uniform value conditional on a lookup that can miss.
	//
	// Left at -1 when no route reports one, because "said nothing" and "said
	// zero" are different and the board treats them differently.
	if r.Best.InUsd > 0 {
		var fee *float64
		for _, rt := range r.Routes {
			if rt.FeeUsd == nil {
				continue
			}
			if rt.Router == r.Best.Router {
				fee = rt.FeeUsd
				break
			}
			if fee == nil {
				fee = rt.FeeUsd
			}
		}
		if fee != nil {
			quote.FeeBps = 10000 * (*fee) / r.Best.InUsd
		}
	}
	return quote, nil
}
