package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// ParaSwapProvider hits api.paraswap.io/prices. No key, verified
// 2026-10-19: a bare GET returns a full priceRoute. The company trades as
// Velora now and DefiLlama lists it under that name, $1.17B over 30 days
// across 9 chains; the slug stays paraswap because the API, the adapter in
// token-quote-coverage and the provider registry all already use it, and
// renaming a slug costs a redirect and a cell of history.
//
// Ported from harnesses/token-quote-coverage, which has probed the same
// endpoint for months. That one asks a coverage question, 1 USDC into a
// new token, and only keeps whether a route came back; this one keeps the
// amount.
//
// NATIVE-ETH SENTINEL: the canonical 0xEeee form.
type ParaSwapProvider struct {
	region string
	client *http.Client
}

func NewParaSwapProvider(region string) *ParaSwapProvider {
	return &ParaSwapProvider{region: region, client: newWarmHTTPClient()}
}

func (p *ParaSwapProvider) Slug() string { return "paraswap" }

// 4663 is Robinhood Chain, added 2026-10-25 after asking rather than
// assuming: the board showed three of nine aggregators there, and the six
// absences were THIS list, not a measurement. ParaSwap answers the
// harness's own Robinhood pair (0.1 ETH to USDG) with a full priceRoute at
// network 4663, so the row was empty because we never asked.
//
// Checked at the same time and NOT added: CoW serves mainnet, base and
// arbitrum_one and answers 404 on robinhood, so its empty row is correct
// and belongs there.
func (p *ParaSwapProvider) Supports(chainId int) bool {
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114, 4663:
		return true
	}
	return false
}

func (p *ParaSwapProvider) Probe(ctx context.Context, pair TestPair) (Quote, error) {
	q := url.Values{}
	q.Set("srcToken", pair.TokenIn)
	q.Set("destToken", pair.TokenOut)
	q.Set("amount", pair.AmountWei)
	q.Set("network", strconv.Itoa(pair.ChainId))
	// Decimals are required and not inferred: send the pair's own, or the
	// amount is read at the wrong scale and the quote comes back absurd.
	q.Set("srcDecimals", strconv.Itoa(pair.TokenInDec))
	q.Set("destDecimals", strconv.Itoa(pair.TokenOutDec))
	q.Set("side", "SELL")
	endpoint := "https://api.paraswap.io/prices?" + q.Encode()

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Accept", "application/json")

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
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return failed(), fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var r struct {
		PriceRoute struct {
			DestAmount  string `json:"destAmount"`
			BlockNumber uint64 `json:"blockNumber"`
			// ParaSwap reports units and a USD cost but no gas price, so
			// only the units are read; the USD figure carries ParaSwap's
			// own price assumption and is not comparable with anyone's.
			GasCost any `json:"gasCost"`
		} `json:"priceRoute"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return failed(), err
	}
	if r.PriceRoute.DestAmount == "" || r.PriceRoute.DestAmount == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("no_route")
	}
	quote := okQuote(ms, r.PriceRoute.DestAmount)
	quote.GasUnits = uintAny(r.PriceRoute.GasCost)
	quote.Block = r.PriceRoute.BlockNumber
	return quote, nil
}
