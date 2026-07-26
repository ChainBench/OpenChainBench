package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

const (
	paraswapUSDCBase      = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	paraswapUSDCBSC       = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
	paraswapUSDGRobinhood = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
)

type ParaSwapProvider struct {
	client *http.Client
}

func NewParaSwapProvider() *ParaSwapProvider {
	return &ParaSwapProvider{client: newWarmHTTPClient()}
}

func (p *ParaSwapProvider) Slug() string { return "paraswap" }

func (p *ParaSwapProvider) SupportsChain(chain string) bool {
	return chain == "base" || chain == "bsc" || chain == "robinhood"
}

func (p *ParaSwapProvider) Quote(ctx context.Context, token Token) (ok bool) {
	var network, usdcAddr string
	switch token.Chain {
	case "base":
		network = "8453"
		usdcAddr = paraswapUSDCBase
	case "bsc":
		network = "56"
		usdcAddr = paraswapUSDCBSC
	case "robinhood":
		network = "4663"
		usdcAddr = paraswapUSDGRobinhood
	default:
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	q := url.Values{}
	q.Set("srcToken", usdcAddr)
	q.Set("destToken", token.Address)
	q.Set("amount", "1000000")
	q.Set("network", network)
	q.Set("srcDecimals", "6")
	q.Set("destDecimals", "18")
	q.Set("side", "SELL")
	endpoint := "https://apiv5.paraswap.io/prices?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[paraswap] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		fmt.Printf("[paraswap] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	var r struct {
		PriceRoute struct {
			DestAmount string `json:"destAmount"`
		} `json:"priceRoute"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[paraswap] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	ok = r.PriceRoute.DestAmount != "" && r.PriceRoute.DestAmount != "0"
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
